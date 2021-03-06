// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const aiLogger = require('winston-azure-application-insights').AzureApplicationInsightsLogger;
const AmqpQueue = require('./amqpQueue');
const Amqp10Queue = require('./amqp10Queue');
const appInsights = require('applicationinsights');
const AzureStorage = require('azure-storage');
const AttenuatedQueue = require('./attenuatedQueue');
const AzureStorageDocStore = require('./storageDocStore');
const ComputeLimiter = require('./computeLimiter');
const config = require('painless-config');
const Crawler = require('ghcrawler').crawler;
const CrawlerService = require('ghcrawler').crawlerService;
const fs = require('fs');
const GitHubFetcher = require('ghcrawler').githubFetcher;
const GitHubProcessor = require('ghcrawler').githubProcessor;
const InMemoryCrawlQueue = require('./inmemorycrawlqueue');
const InMemoryDocStore = require('./inmemoryDocStore');
const InMemoryRateLimiter = require('./inmemoryRateLimiter');
const ip = require('ip');
const LimitedTokenFactory = require('./limitedTokenFactory');
const LoggingStore = require('./loggingStore');
const mockInsights = require('./mockInsights');
const MongoDocStore = require('./mongodocstore');
const MultiStore = require('./multiStore');
const policy = require('ghcrawler').policy;
const Q = require('q');
const QueueSet = require('ghcrawler').queueSet;
const RateLimitedPushQueue = require('./ratelimitedPushQueue');
const redis = require('redis');
const RedisRequestTracker = require('./redisRequestTracker');
const RedisMetrics = require('redis-metrics');
const RedisRateLimiter = require('redis-rate-limiter');
const redlock = require('redlock');
const RefreshingConfig = require('refreshing-config');
const RefreshingConfigRedis = require('refreshing-config-redis');
const request = require('request');
const Request = require('ghcrawler').request;
const requestor = require('ghrequestor');
const ServiceBusSubscription = require('./serviceBusSubscription');
const TokenFactory = require('./tokenFactory');
const TrackedQueue = require('./trackedQueue');
const UrlToUrnMappingStore = require('./urlToUrnMappingStore');
const winston = require('winston');

redisClients = {};

class OspoCrawler {

  static getDefaultOptions() {
    return {
      crawler: {
        name: config.get('CRAWLER_NAME') || 'crawler',
        count: 0,
        pollingDelay: 5000,
        processingTtl: 60 * 1000,
        promiseTrace: false,
        orgList: OspoCrawler._loadLines(config.get('CRAWLER_ORGS_FILE'))
      },
      fetcher: {
        tokenLowerBound: 50,
        metricsStore: 'redis',
        callCapStore: 'memory',
        callCapWindow: 1,       // seconds
        callCapLimit: 30,       // calls
        computeLimitStore: 'memory',
        computeWindow: 15,      // seconds
        computeLimit: 15000,    // milliseconds
        baselineFrequency: 60,  // seconds
        deferDelay: 500
      },
      queuing: {
        weights: [3, 2, 3, 2],
        messageSize: 200,
        parallelPush: 10,
        pushRateLimit: 300,
        metricsStore: 'redis',
        provider: config.get('CRAWLER_QUEUE_PROVIDER') || 'amqp10',
        queueName: config.get('CRAWLER_QUEUE_PREFIX') || 'crawler',
        events: {
          weight: 10,
          topic: config.get('CRAWLER_EVENT_TOPIC_NAME') || 'crawler',
          queueName: config.get('CRAWLER_EVENT_QUEUE_NAME') || 'crawler'
        },
        attenuation: {
          ttl: 3000
        },
        tracker: {
          // driftFactor: 0.01,
          // retryCount: 3,
          // retryDelay: 200,
          // locking: true,
          // lockTtl: 1000,
          ttl: 60 * 60 * 1000
        },
        credit: 50
      },
      storage: {
        ttl: 6 * 1000,
        provider: config.get('CRAWLER_STORE_PROVIDER') || 'azure',
        delta: {
          provider: config.get('CRAWLER_STORE_DELTA_PROVIDER')
        }
      },
      locker: {
        provider: 'redis',
        retryCount: 3,
        retryDelay: 200
      }
    };
  }

  static createService(name) {
    const crawlerName = config.get('CRAWLER_NAME') || 'crawler';
    const optionsProvider = config.get('CRAWLER_OPTIONS_PROVIDER') || 'memory';
    const subsystemNames = ['crawler', 'fetcher', 'queuing', 'storage', 'locker'];
    const crawlerPromise = OspoCrawler.createRefreshingOptions(crawlerName, subsystemNames, optionsProvider).then(options => {
      OspoCrawler._decorateOptions(options);
      const crawler = OspoCrawler[`create${name}Crawler`](options);
      return [crawler, options];
    });
    return new CrawlerService(crawlerPromise);
  }

  static _createCrawler(options) {
    let store = OspoCrawler.createStore(options.storage);
    if (options.storage.delta && options.storage.delta.provider) {
      store = OspoCrawler.createDeltaStore(store);
    }
    return OspoCrawler.createCrawler(options, { store: store });
  }

  static createStandardCrawler(options) {
    OspoCrawler._enableEvents(options, OspoCrawler.getDefaultOptions().queuing.events.weight);
    return OspoCrawler._createCrawler(options);
  }

  static createStandardWithoutEventsCrawler(options) {
    OspoCrawler._enableEvents(options, 0);
    return OspoCrawler._createCrawler(options);
  }

  static createOldNewCrawler(options) {
    // copy and override the storage options to creat a read store
    const oldOptions = Object.assign({}, options.storage, { role: 'read' });
    const oldStore = OspoCrawler.createRedisAndStorageStore(oldOptions);

    const store = OspoCrawler.createRedisAndStorageStore(options.storage);
    const loggingStore = OspoCrawler.createDeltaStore(store);
    const multiStore = new MultiStore(oldStore, loggingStore, options);
    return OspoCrawler.createCrawler(options, { store: multiStore });
  }

  static createInMemoryCrawler(options) {
    OspoCrawler._enableEvents(options, 0);
    OspoCrawler._configureInMemoryOptions(options);
    return OspoCrawler.createCrawler(options);
  }

  static _configureInMemoryOptions(options) {
    options.fetcher.limitStore = 'memory';
    options.fetcher.metricsStore = null;
    options.queuing.provider = 'memory';
    options.queuing.metricsStore = null;
    options.locker.provider = 'memory';
    options.storage.provider = 'memory';
  }

  static _enableEvents(options, weight) {
    const queuing = options.queuing;
    queuing.events.weight = weight;
    queuing._config.set('events', queuing.events);
    return options;
  }

  static _decorateOptions(options) {
    Object.getOwnPropertyNames(options).forEach(key => {
      const logger = OspoCrawler.createLogger(true);
      options[key].logger = logger;
      const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
      const metricsFactory = OspoCrawler[`create${capitalized}Metrics`];
      if (metricsFactory) {
        logger.metrics = metricsFactory(options.crawler.name, options[key]);
      }
    });
  }

  static createCrawler(
    options, {
      queues = OspoCrawler.createQueues(options.queuing),
      store = OspoCrawler.createStore(options.storage),
      locker = OspoCrawler.createLocker(options.locker),
      fetcher = null,
      processor = null
    } = {}) {

    fetcher = fetcher || OspoCrawler.createGitHubFetcher(store, options.fetcher);
    processor = processor || new GitHubProcessor(store);
    const result = new Crawler(queues, store, locker, fetcher, processor, options.crawler);
    result.initialize = OspoCrawler._initialize.bind(result);
    return result;
  }

  static _initialize() {
    return Q.try(this.queues.subscribe.bind(this.queues))
      .then(this.store.connect.bind(this.store));
  }

  static createRefreshingOptions(crawlerName, subsystemNames, provider = 'redis') {
    const result = {};
    provider = provider.toLowerCase();
    return Q.all(subsystemNames.map(subsystemName => {
      let config = null;
      if (provider === 'redis') {
        config = OspoCrawler.createRedisRefreshingConfig(crawlerName, subsystemName);
      } else if (provider === 'memory') {
        config = OspoCrawler.createInMemoryRefreshingConfig();
      } else {
        throw new Error(`Invalid options provider setting ${provider}`);
      }
      return config.getAll().then(values => {
        const defaults = OspoCrawler.getDefaultOptions();
        return OspoCrawler.initializeSubsystemOptions(values, defaults[subsystemName]).then(resolved =>
          result[subsystemName] = values);
      });
    })).then(() => { return result; });
  }

  static initializeSubsystemOptions(config, defaults) {
    if (Object.getOwnPropertyNames(config).length > 1) {
      return Q(config);
    }
    return Q.all(Object.getOwnPropertyNames(defaults).map(optionName => {
      return config._config.set(optionName, defaults[optionName]);
    })).then(() => { return config._config.getAll(); });
  }

  static createRedisRefreshingConfig(crawlerName, subsystemName) {
    const redisClient = OspoCrawler.getRedisClient(OspoCrawler.createLogger(true));
    const key = `${crawlerName}:options:${subsystemName}`;
    const channel = `${key}-channel`;
    const configStore = new RefreshingConfigRedis.RedisConfigStore(redisClient, key);
    const config = new RefreshingConfig.RefreshingConfig(configStore)
      .withExtension(new RefreshingConfigRedis.RedisPubSubRefreshPolicyAndChangePublisher(redisClient, channel));
    return config;
  }

  static createInMemoryRefreshingConfig(values = {}) {
    const configStore = new RefreshingConfig.InMemoryConfigStore(values);
    const config = new RefreshingConfig.RefreshingConfig(configStore)
      .withExtension(new RefreshingConfig.InMemoryPubSubRefreshPolicyAndChangePublisher());
    return config;
  }

  static createGitHubFetcher(store, options) {
    const requestor = OspoCrawler.createRequestor();
    const tokenFactory = OspoCrawler.createTokenFactory(options);
    const limiter = OspoCrawler.createComputeLimiter(options);
    return new GitHubFetcher(requestor, store, tokenFactory, limiter, options);
  }

  static createTokenFactory(options) {
    const tokenSpecs = config.get('CRAWLER_GITHUB_TOKENS').split(';');
    const tokens = tokenSpecs.map(spec => TokenFactory.createToken(spec));
    const factory = new TokenFactory(tokens, options);
    const limiter = OspoCrawler.createTokenLimiter(options);
    return new LimitedTokenFactory(factory, limiter, options);
  }

  static createRequestor() {
    return requestor.defaults({
      // turn off the requestor's throttle management mechanism in favor of ours
      forbiddenDelay: 0,
      delayOnThrottle: false
    });
  }

  static createFetcherMetrics(crawlerName, options) {
    if (options.metricsStore !== 'redis') {
      return null;
    }
    const metrics = new RedisMetrics({ client: OspoCrawler.getRedisClient(options.logger) });
    const names = ['fetch'];
    const result = {};
    names.forEach(name => {
      const fullName = `${crawlerName}:github:${name}`;
      result[name] = metrics.counter(fullName, { timeGranularity: 'second', namespace: 'crawlermetrics' }); // Stored in Redis as {namespace}:{name}:{period}
    });
    return result;
  }

  static createTokenLimiter(options) {
    return options.capStore === 'redis'
      ? OspoCrawler.createRedisTokenLimiter(getRedisClient(options.logger), options)
      : OspoCrawler.createInMemoryTokenLimiter(options);
  }

  static createRedisTokenLimiter(redisClient, options) {
    const ip = '';
    return RedisRateLimiter.create({
      redis: redisClient,
      key: request => `${ip}:token:${request.key}`,
      window: () => options.callCapWindow || 1,
      limit: () => options.callCapLimit
    });
  }

  static createInMemoryTokenLimiter(options) {
    return InMemoryRateLimiter.create({
      key: request => 'token:' + request.key,
      window: () => options.callCapWindow || 1,
      limit: () => options.callCapLimit
    });
  }

  static createComputeLimiter(options) {
    const limiter = options.computeLimitStore === 'redis'
      ? OspoCrawler.createRedisComputeLimiter(OspoCrawler.getRedisClient(options.logger), options)
      : OspoCrawler.createInMemoryComputeLimiter(options);
    options.baselineUpdater = OspoCrawler._networkBaselineUpdater.bind(null, options.logger);
    return new ComputeLimiter(limiter, options);
  }

  static _networkBaselineUpdater(logger) {
    return Q.allSettled([0, 1, 2, 3].map(number => {
      return Q.delay(number * 50).then(() => {
        const deferred = Q.defer();
        request({
          url: 'https://api.github.com/rate_limit',
          headers: {
            'User-Agent': 'ghrequestor'
          },
          time: true
        }, (error, response, body) => {
          if (error) {
            return deferred.reject(error);
          }
          deferred.resolve(response.elapsedTime);
        });
        return deferred.promise;
      });
    })).then(times => {
      let total = 0;
      let count = 0;
      for (let index in times) {
        if (times[index].state === 'fulfilled') {
          total += times[index].value;
          count++;
        }
      }
      const result = Math.floor(total / count);
      logger.info(`New GitHub request baseline: ${result}`);
      return result;
    });
  }

  static createRedisComputeLimiter(redisClient, options) {
    const address = ip.address().toString();
    return RedisRateLimiter.create({
      redis: redisClient,
      key: request => `${address}:compute:${request.key}`,
      incr: request => request.amount,
      window: () => options.computeWindow || 15,
      limit: () => options.computeLimit || 15000
    });
  }

  static createInMemoryComputeLimiter(options) {
    return InMemoryRateLimiter.create({
      key: request => 'compute:' + request.key,
      incr: request => request.amount,
      window: () => options.computeWindow || 15,
      limit: () => options.computeLimit || 15000
    });
  }

  static createStore(options) {
    const provider = options.provider || 'azure';
    switch (options.provider) {
      case 'azure': {
        return OspoCrawler.createRedisAndStorageStore(options);
      }
      case 'mongo': {
        return OspoCrawler.createMongoStore(options);
      }
      case 'memory': {
        return new InMemoryDocStore(true);
      }
      default: throw new Error(`Invalid store provider: ${provider}`);
    }
  }

  static createMongoStore(options) {
    return new MongoDocStore(config.get('CRAWLER_MONGO_URL'), options);
  }

  static createRedisAndStorageStore(options, name = null) {
    const baseStore = OspoCrawler.createAzureStorageStore(options, name);
    return new UrlToUrnMappingStore(baseStore, OspoCrawler.getStorageRedisClient(options), baseStore.name, options);
  }

  static createAzureStorageStore(options, name = null) {
    const role = options.role ? `.${options.role}` : '';
    name = name || config.get(`CRAWLER_STORAGE_NAME${role}`) || config.get('CRAWLER_STORAGE_NAME');
    const account = config.get(`CRAWLER_STORAGE_ACCOUNT${role}`) || config.get('CRAWLER_STORAGE_ACCOUNT');
    const key = config.get(`CRAWLER_STORAGE_KEY${role}`) || config.get('CRAWLER_STORAGE_KEY');
    const blobService = OspoCrawler.createBlobService(account, key);
    return new AzureStorageDocStore(blobService, name, options);
  }

  static createDeltaStore(baseStore, name = null, options = {}) {
    name = name || config.get('CRAWLER_DOCLOG_STORAGE_NAME') || `${config.get('CRAWLER_STORAGE_NAME')}-log`;
    const account = config.get('CRAWLER_DOCLOG_STORAGE_ACCOUNT') || config.get('CRAWLER_STORAGE_ACCOUNT');
    const key = config.get('CRAWLER_DOCLOG_STORAGE_KEY') || config.get('CRAWLER_STORAGE_KEY');
    const blobService = OspoCrawler.createBlobService(account, key);
    return new LoggingStore(baseStore, blobService, name, options);
  }

  static getStorageRedisClient(options = {}) {
    const role = options.role ? `.${options.role}` : '';
    if (redisClients[role]) {
      return redisClients[role];
    }
    const url = config.get(`CRAWLER_STORAGE_REDIS_URL${role}`) || config.get('CRAWLER_STORAGE_REDIS_URL') || config.get('CRAWLER_REDIS_URL');
    const port = config.get(`CRAWLER_STORAGE_REDIS_PORT${role}`) || config.get('CRAWLER_STORAGE_REDIS_PORT') || config.get('CRAWLER_REDIS_PORT');
    const key = config.get(`CRAWLER_STORAGE_REDIS_ACCESS_KEY${role}`) || config.get('CRAWLER_STORAGE_REDIS_ACCESS_KEY') || config.get('CRAWLER_REDIS_ACCESS_KEY');

    const redisClient = OspoCrawler.createRedisClient(url, key, port, OspoCrawler.createLogger(true));
    redisClients[role] = redisClient;
    return redisClients[role];
  }

  static getRedisClient(logger) {
    const role = 'default';
    if (redisClients[role]) {
      return redisClients[role];
    }
    const url = config.get('CRAWLER_REDIS_URL');
    const port = config.get('CRAWLER_REDIS_PORT');
    const key = config.get('CRAWLER_REDIS_ACCESS_KEY');
    const tls = config.get('CRAWLER_REDIS_TLS') === 'true';

    const redisClient = OspoCrawler.createRedisClient(url, key, port, tls, logger);
    redisClients[role] = redisClient;
    return redisClients[role];
  }

  static createRedisClient(url, key, port, tls, logger) {
    const options = {};
    if (key) {
      options.auth_pass = key
    }
    if (tls) {
      options.tls = {
        servername: url
      }
    }
    const redisClient = redis.createClient(port, url, options);
    redisClient.on('error', error => logger.info(`Redis client error: ${error}`));
    redisClient.on('reconnecting', properties => logger.info(`Redis client reconnecting: ${JSON.stringify(properties)}`));
    setInterval(() => {
      redisClient.ping(err => {
        if (err) { logger.info(`Redis client ping failure: ${err}`); }
      });
    }, 60 * 1000);
    return redisClient;
  }

  static createBlobService(account, key) {
    const retryOperations = new AzureStorage.ExponentialRetryPolicyFilter();
    return AzureStorage.createBlobService(account, key).withFilter(retryOperations);
  }

  static createLocker(options) {
    if (options.provider === 'memory') {
      return OspoCrawler.createNolock();
    }
    return new redlock([OspoCrawler.getRedisClient(options.logger)], {
      driftFactor: 0.01,
      retryCount: options.retryCount,
      retryDelay: options.retryDelay
    });
  }

  static createLogger(echo = false, level = 'info') {
    mockInsights.setup(config.get('CRAWLER_INSIGHTS_KEY'), echo);
    const result = new winston.Logger();
    result.add(aiLogger, {
      insights: appInsights,
      treatErrorsAsExceptions: true,
      exitOnError: false,
      level: level
    });
    // winston.remove(winston.transports.Console);
    return result;
  }

  static createRequestTracker(prefix, options) {
    let locker = null;
    if (options.tracker.locking) {
      locker = new redlock([OspoCrawler.getRedisClient(options.logger)], options.tracker);
    } else {
      locker = OspoCrawler.createNolock();
    }
    return new RedisRequestTracker(prefix, OspoCrawler.getRedisClient(options.logger), locker, options);
  }

  static createNolock() {
    return { lock: () => null, unlock: () => { } };
  }

  static createQueues(options) {
    const provider = options.provider || 'amqp10';
    if (provider === 'amqp10') {
      return OspoCrawler.createAmqp10Queues(options);
    } else if (provider === 'amqp') {
      return OspoCrawler.createAmqpQueues(options);
    } else if (provider === 'memory') {
      return OspoCrawler.createMemoryQueues(options);
    } else {
      throw new Error(`Invalid queue provider option: ${provider}`);
    }
  }

  static addEventQueue(queues, options) {
    if (options.events.weight) {
      options.weights.unshift(options.events.weight);
      queues.unshift(OspoCrawler.createEventQueue(options));
    }
    return queues;
  }

  static createAmqpQueues(options) {
    const url = config.get('CRAWLER_AMQP_URL');
    const env = process.env.NODE_ENV;
    const tracker = OspoCrawler.createRequestTracker(`${env}:AMQP:${options.queueName}`, options);
    const immediate = OspoCrawler.createAmqpQueue(url, 'immediate', tracker, options);
    const soon = OspoCrawler.createAmqpQueue(url, 'soon', tracker, options);
    const normal = OspoCrawler.createAmqpQueue(url, 'normal', tracker, options);
    const later = OspoCrawler.createAmqpQueue(url, 'later', tracker, options);
    const deadletter = OspoCrawler.createAmqpQueue(url, 'deadletter', tracker, options);
    const queues = OspoCrawler.addEventQueue([immediate, soon, normal, later], options);
    return new QueueSet(queues, deadletter, options);
  }

  static createAmqp10Queues(options) {
    const url = config.get('CRAWLER_AMQP10_URL');
    const factory = new Amqp10Queue(url);
    const env = process.env.NODE_ENV;
    const tracker = OspoCrawler.createRequestTracker(`${env}:AMQP10:${options.queueName}`, options);
    const immediate = OspoCrawler.createAmqp10Queue(factory, 'immediate', tracker, options);
    const soon = OspoCrawler.createAmqp10Queue(factory, 'soon', tracker, options);
    const normal = OspoCrawler.createAmqp10Queue(factory, 'normal', tracker, options);
    const later = OspoCrawler.createAmqp10Queue(factory, 'later', tracker, options);
    const deadletter = OspoCrawler.createAmqp10Queue(factory, 'deadletter', tracker, options, false);
    const queues = OspoCrawler.addEventQueue([immediate, soon, normal, later], options);
    return new QueueSet(queues, deadletter, options);
  }

  static createMemoryQueues(options) {
    const immediate = OspoCrawler.createMemoryQueue('immediate', options);
    const soon = OspoCrawler.createMemoryQueue('soon', options);
    const normal = OspoCrawler.createMemoryQueue('normal', options);
    const later = OspoCrawler.createMemoryQueue('later', options);
    const deadletter = OspoCrawler.createMemoryQueue('deadletter', options);
    const queues = OspoCrawler.addEventQueue([immediate, soon, normal, later], options);
    return new QueueSet(queues, deadletter, options);
  }

  static createMemoryQueue(name, options) {
    return new AttenuatedQueue(new InMemoryCrawlQueue(name, options), options);
  }

  static createAmqpQueue(url, name, tracker, options) {
    const formatter = message => {
      return Request.adopt(JSON.parse(message));
    };
    const queue = new AmqpQueue(url, name, formatter, options);
    return new AttenuatedQueue(new TrackedQueue(queue, tracker, options), options);
  }

  static createAmqp10Queue(factory, name, tracker, options, receive = true) {
    const formatter = !receive ? null : message => {
      // make sure the message/request object is copied to enable deferral scenarios (i.e., the request is modified
      // and then put back on the in-memory queue)
      return Request.adopt(Object.assign({}, message));
    };
    const queue = factory.createQueue(name, formatter, options);
    const trackedQueue = new TrackedQueue(queue, tracker, options);
    let innerQueue = trackedQueue;
    if (options.pushRateLimit) {
      const limiter = InMemoryRateLimiter.create({
        key: () => 'queue:' + name,
        window: () => options.pushRateWindow || 2,
        limit: () => options.pushRateLimit || 300
      });

      innerQueue = new RateLimitedPushQueue(trackedQueue, limiter, options);
    }
    const attenuatedQueue = new AttenuatedQueue(innerQueue, options);
    return attenuatedQueue;
  }

  static createEventQueue(options) {
    // Setup the event trigger mechanism to read off a service bus topic and format
    // the events as { type: type, qualifier: qualifier } if they are relevant
    const formatter = new EventFormatter(options);
    options._config.on('change', formatter.reconfigure.bind(formatter));

    const url = config.get('CRAWLER_EVENT_SERVICEBUS_URL');
    return new ServiceBusSubscription(url, 'events', options.events.topic, options.events.queueName, formatter.format.bind(formatter), null, options);
  }

  static createQueuingMetrics(crawlerName, options) {
    if (options.metricsStore !== 'redis') {
      return null;
    }
    const metrics = new RedisMetrics({ client: OspoCrawler.getRedisClient(options.logger) });
    const queueNames = ['immediate', 'soon', 'normal', 'later', 'deadletter', 'events'];
    const operations = ['push', 'repush', 'done', 'abandon'];
    const queuesMetrics = {};
    const queueNamePrefix = options.queueName;
    queueNames.forEach(queueName => {
      queuesMetrics[queueName] = {};
      operations.forEach(operation => {
        const name = `${queueNamePrefix}:${queueName}:${operation}`;
        queuesMetrics[queueName][operation] = metrics.counter(name, { timeGranularity: 'second', namespace: 'crawlermetrics' }); // Stored in Redis as {namespace}:{name}:{period}
      });
    });
    return queuesMetrics;
  }

  // TODO need to reload from time to time to allow updating of the org filter list when new orgs are discovered.
  // Harder than you'd think.  May be many agents running.  As soon as we discover a new org, we might start
  // seeing events from it.  The agents all need to get the updated filter.
  static _loadLines(path) {
    if (!path || !fs.existsSync(path)) {
      return [];
    }
    let result = fs.readFileSync(path, 'utf8');
    result = result.split(/\s/);
    return result.filter(line => { return line; }).map(line => { return line.toLowerCase(); });
  }
}

module.exports = OspoCrawler;

class EventFormatter {
  constructor(options) {
    this.options = options;
    this.repoEvents = new Set(options.events.repoEvents || ['commit_comment', 'create', 'delete', 'deployment', 'deployment_status', 'gollum', 'issue_comment', 'issues', 'label', 'milestone', 'page_build', 'public', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'push', 'release', 'repository', 'status', 'watch']);
    this.orgEvents = new Set(options.events.orgEvents || ['member', 'membership', 'organization', 'team', 'team_add']);
  }

  reconfigure(patches) {
    if (patches.some(patch => patch.path === '/events/repoEvents') || patches.some(patch => patch.path === '/events/orgEvents')) {
      this.repoEvents = new Set(options.events.repoEvents);
      this.orgEvents = new Set(options.events.orgEvents);
    }
    return Q();
  }

  format(message) {
    const type = message.customProperties.event;
    const event = JSON.parse(message.body);
    let request = null;
    if (this.repoEvents.has(type)) {
      request = new Request('update_events', event.repository.events_url, { qualifier: `urn:repo:${event.repository.id}` });
    } else if (this.orgEvents.has(type)) {
      request = new Request('update_events', event.organization.events_url, { qualifier: `urn:repo:${event.organization.id}` });
    }
    // if we found something interesting, tweak the request to reflect the event
    if (request) {
      // if the event is for a private repo, mark the request as needing private access.
      if (event.repository && event.repository.private) {
        request.context.repoType = 'private';
      }
      // mark it to be retried on the immediate queue as we don't want to requeue it on this shared topic
      request._retryQueue = 'immediate';
    }
    return request;
  }
}
