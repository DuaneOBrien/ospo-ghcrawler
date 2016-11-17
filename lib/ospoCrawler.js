const aiLogger = require('winston-azure-application-insights').AzureApplicationInsightsLogger;
const AmqpQueue = require('./amqpQueue');
const appInsights = require("applicationinsights");
const config = require('painless-config');
const Crawler = require('ghcrawler').crawler;
const fs = require('fs');
const InMemoryCrawlQueue = require('./inmemorycrawlqueue');
const InmemoryDocStore = require('./inmemoryDocStore');
const mockInsights = require('./mockInsights');
const MongoDocStore = require('./mongodocstore');
const Q = require('q');
const QueueSet = require('ghcrawler').queueSet;
const redis = require('redis');
const redlock = require('redlock');
const request = require('ghcrawler').request;
const requestor = require('ghrequestor');
const ServiceBusCrawlQueue = require('./servicebuscrawlqueue');
const winston = require('winston');

redisClient = null;
class OspoCrawler {

  static run(agentCount) {
    const crawler = OspoCrawler.createTypicalSetup();
    OspoCrawler.runCrawler(crawler, agentCount);
  }

  static createTypicalSetup() {
    const queues = OspoCrawler.createQueues();
    const store = OspoCrawler.createStore();
    const locker = OspoCrawler.createLocker();
    const requestorInstance = OspoCrawler.createRequestor();
    const options = OspoCrawler.createOptions();
    const logger = OspoCrawler.createLogger(false, true);
    return new Crawler(queues, store, locker, requestorInstance, options, logger);
  }

  static cleanRunCrawler(crawler, agentCount, seedRequests = null) {
    return crawler.queues.unsuscribe().then(() => {
      return OspoCrawler.run(crawler, agentCount, seedRequests);
    });
  }

  static runCrawler(crawler, agentCount, seedRequests = null) {
    return Q.try(() => crawler.queues.subscribe())
      .then(() => crawler.queues.push(seedRequests || []))
      .then(crawler.store.connect.bind(crawler.store))
      .then(() => OspoCrawler._start(crawler, agentCount))
      .catch(error => crawler.logger.error(error))
      .finally(() =>
        crawler.logger.info(`Exiting Crawler: ${crawler.name}`))
      .done();
  }

  static _start(crawler, count) {
    const promises = [];
    const jobName = config.get('WEBJOBS_NAME') || 'default';
    for (let i = 1; i <= count; i++) {
      promises.push(crawler.start(`${jobName}-${i}`));
    }
    return Q.allSettled(promises).then(() => console.log('Done all crawler loops'));
  }

  static createSeedRequest(type, url, qualifier) {
    const result = new request(type, url);
    result.force = true;
    result.context = { qualifier: qualifier };
    return result;
  }

  static createQueues(fake = false) {
    const url = fake ? null : config.get('GHCRAWLER_SERVICEBUS_URL');
    const topic = config.get('GHCRAWLER_SERVICEBUS_TOPIC') || 'crawlqueue';
    const priority = OspoCrawler.createQueue(url, topic + '-priority', 'priority');
    const normal = OspoCrawler.createQueue(url, topic + '-normal', 'normal');
    const deadletter = OspoCrawler.createQueue(url, topic + '-deadletter', 'deadletter');
    return new QueueSet(priority, normal, deadletter);
  }

  static createAmqpQueues(fake = false) {
    const url = fake ? null : 'amqp://localhost';
    const topic = config.get('GHCRAWLER_SERVICEBUS_TOPIC') || 'crawlqueue';
    const priority = OspoCrawler.createAmqpQueue(url, topic + '-priority');
    const normal = OspoCrawler.createAmqpQueue(url, topic + '-normal');
    const deadletter = OspoCrawler.createAmqpQueue(url, topic + '-deadletter');
    return new QueueSet(priority, normal, deadletter);
  }

  static createRequestor() {
    return requestor.defaults({
      forbiddenDelay: 0,
      delayOnThrottle: false,
      headers: {
        authorization: `token ${config.get('GHCRAWLER_GITHUB_TOKEN')}`
      }
    });
  }

  static createStore(fake = false) {
    if (fake) {
      return new InmemoryDocStore();
    }
    return new MongoDocStore(config.get('GHCRAWLER_MONGO_URL'));
  }

  static createOptions() {
    return {
      orgFilter: OspoCrawler._loadLines(config.get('GHCRAWLER_ORGS_FILE'))
    };
  }

  static getRedisClient() {
    if (redisClient) {
      return redisClient;
    }
    const redisOptions = { auth_pass: config.get('GHCRAWLER_REDIS_ACCESS_KEY') };
    redisOptions.tls = { servername: config.get('GHCRAWLER_REDIS_URL') };
    redisClient = redis.createClient(config.get('GHCRAWLER_REDIS_PORT'), config.get('GHCRAWLER_REDIS_URL'), redisOptions);
    return redisClient;
  }

  static createLocker(fake = false) {
    if (fake) {
      return null;
    }
    return new redlock([OspoCrawler.getRedisClient()], {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200
    });
  }

  // TODO need to reload from time to time to allow updating of the org filter list when new orgs are discovered.
  // Harder than you'd think.  May be many agents running.  As soon as we discover a new org, we might start
  // seeing events from it.  The agents all need to get the updated filter.
  static _loadLines(path) {
    if (!path || !fs.existsSync(path)) {
      return new Set();
    }
    let result = fs.readFileSync(path, 'utf8');
    result = result.split(/\s/);
    return new Set(result.filter(line => { return line; }).map(line => { return line.toLowerCase(); }));
  }

  static createLogger(fake = false, echo = false, level = 'info') {
    mockInsights.setup(fake ? null : config.get('GHCRAWLER_INSIGHTS_KEY'), echo);
    winston.add(aiLogger, {
      insights: appInsights,
      treatErrorsAsExceptions: true,
      level: level
    });
    winston.remove(winston.transports.Console);
    return winston;
  }

  static createQueue(url, topic, subscription) {
    if (!url) {
      return new InMemoryCrawlQueue();
    }
    const formatter = message => {
      const result = JSON.parse(message.body);
      // Attach our "request" functionality to the loaded object
      result.__proto__ = request.prototype;
      return result;
    };
    return new ServiceBusCrawlQueue(url, topic, subscription, formatter);
  }

  static createAmqpQueue(url, name) {
    if (!url) {
      return new InMemoryCrawlQueue();
    }
    const formatter = message => {
      const result = JSON.parse(message);
      // Attach our "request" functionality to the loaded object
      result.__proto__ = request.prototype;
      return result;
    };
    return new AmqpQueue(url, name, formatter, OspoCrawler.getRedisClient());
  }
}

module.exports = OspoCrawler;