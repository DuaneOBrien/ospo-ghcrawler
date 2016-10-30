const assert = require('chai').assert;
const chai = require('chai');
const expect = require('chai').expect;
const extend = require('extend');
const GitHubRequest = require('../lib/githubRequest.js');
const request = require('requestretry');

const urlHost = 'https://test.com';

describe('Request option merging', () => {
  it('should merge and override properties', () => {
    const result = new GitHubRequest({
      retryDelay: 10,
      testProperty: 'test value'
    });
    expect(result.options.retryDelay).to.equal(10);
    expect(result.options.testProperty).to.equal('test value');
  });

  it('should merge and override headers', () => {
    const result = new GitHubRequest({
      headers: {
        'User-Agent': 'test agent',
        authorization: 'test auth'
      }
    });
    expect(result.options.headers['User-Agent']).to.equal('test agent');
    expect(result.options.headers['authorization']).to.equal('test auth');
  });
});

describe('Request retry and success', () => {
  it('should be able to get a single page resource', () => {
    const responses = [createSingleResponse({ id: 'cool object' })];
    const request = createRequest(responses);
    request.get(`${urlHost}/singlePageResource`).then(result => {
      expect(result.id).to.equal('cool object');
      const activity = request.activity[0];
      expect(activity.attempts).to.equal(1);
    });
  });

  it('should be able to get a multi page resource', () => {
    const responses = [
      createMultiPageResponse('twoPageResource', [{ page: 1 }], null, 2),
      createMultiPageResponse('twoPageResource', [{ page: 2 }], 1, null)
    ];
    const requestTracker = [];
    const request = createRequest(responses, requestTracker);
    return request.getAll(`${urlHost}/twoPageResource`).then(result => {
      expect(result.length).to.equal(2);
      expect(result[0].page).to.equal(1);
      expect(result[1].page).to.equal(2);
      expect(request.activity[0].attempts).to.equal(1);
      expect(request.activity[1].attempts).to.equal(1);

      expect(requestTracker.length).to.equal(2);
      expect(requestTracker[0]).to.not.include('?page=1');
      expect(requestTracker[0]).to.not.include('&page=1');
      expect(requestTracker[0]).to.include('per_page');
      expect(requestTracker[1]).to.include('page=2');
      expect(requestTracker[1]).to.include('per_page');
    }, err => {
      assert.fail();
    });
  });

  it('should retry 500 errors and eventually fail', () => {
    const responses = [
      createSingleResponse('bummer', 500),
      createSingleResponse('bummer', 500),
      createSingleResponse('bummer', 500),
      createSingleResponse('bummer', 500),
      createSingleResponse('bummer', 500)
    ];
    const request = createRequest(responses);
    return request.getAll(`${urlHost}/serverError`).then(result => {
      // TODO what should be the right return value from a 500?
      // The body of the response or the response itself?
      expect(result).to.equal('bummer');
      const activity = request.activity[0];
      expect(activity.attempts).to.equal(request.options.maxAttempts);
      expect(activity.delays[0].retry).to.equal(request.options.retryDelay);
    }, err => {
      assert.fail();
    });
  });

  it('should retry 500 errors and eventually succeed', () => {
    const responses = [
      createSingleResponse('bummer', 500),
      createSingleResponse({ id: 1 }),
      createSingleResponse({ id: 2 })
    ];
    const request = createRequest(responses);
    return request.getAll(`${urlHost}/retry500succeed`).then(result => {
      expect(result.id).to.equal(1);
      const activity = request.activity[0];
      expect(activity.attempts).to.equal(2);
      expect(activity.delays[0].retry).to.equal(request.options.retryDelay);
    }, err => {
      assert.fail();
    });
  });

  it('should retry network errors and eventually fail', () => {
    const responses = [
      createErrorResponse('bummer'),
      createErrorResponse('bummer'),
      createErrorResponse('bummer'),
      createErrorResponse('bummer'),
      createErrorResponse('bummer')
    ];
    const request = createRequest(responses);
    return request.getAll(`${urlHost}/networkError`).then(result => {
      assert.fail();
    }, err => {
      expect(err).to.equal('bummer');
      const activity = request.activity[0];
      expect(activity.attempts).to.equal(5);
      expect(activity.delays[0].retry).to.equal(request.options.retryDelay);
    });
  });

  it('should retry network errors and eventually succeed', () => {
    const responses = [
      createErrorResponse('bummer 1'),
      createErrorResponse('bummer 2'),
      createSingleResponse({ id: 1 }),
      createSingleResponse({ id: 2 })
    ];
    const request = createRequest(responses);
    return request.getAll(`${urlHost}/retryNetworkErrorSucceed`).then(result => {
      expect(result.id).to.equal(1);
      const activity = request.activity[0];
      expect(activity.attempts).to.equal(3);
      expect(activity.delays.length).to.equal(2);
      expect(activity.delays[0].retry).to.equal(request.options.retryDelay);
      expect(activity.delays[1].retry).to.equal(request.options.retryDelay);
    }, err => {
      assert.fail();
    });
  });

  it('should recover after 403 forbidden', () => {
    const responses = [
      createSingleResponse('forbidden 1', 403),
      createSingleResponse({ id: 1 }),
      createSingleResponse({ id: 2 })
    ];
    const request = createRequest(responses);
    return request.getAll(`${urlHost}/forbidden`).then(result => {
      expect(result.id).to.equal(1);
      const activity = request.activity[0];
      expect(activity.attempts).to.equal(2);
      expect(activity.delays.length).to.equal(1);
      expect(activity.delays[0].forbidden).to.equal(request.options.forbiddenDelay);
    }, err => {
      assert.fail();
    });
  });

  it('should recover after error and deliver all pages', () => {
    const responses = [
      // createMultiPageResponse(target, body, previous, next, last, code = 200, error = null, remaining = 4000) {
      createMultiPageResponse('pagedWithErrors', [{ page: 1 }], null, 2),
      createMultiPageResponse('pagedWithErrors', [{ page: 2 }], 1, null, 2, null, 'bummer'),
      createMultiPageResponse('pagedWithErrors', [{ page: 2 }], 1, null)
    ];
    const request = createRequest(responses);
    return request.getAll(`${urlHost}/pagedWithErrors`).then(result => {
      expect(result.length).to.equal(2);
      expect(result[0].page).to.equal(1);
      expect(result[1].page).to.equal(2);

      expect(request.activity.length).to.equal(2);
      const activity0 = request.activity[0];
      expect(activity0.attempts).to.equal(1);
      expect(activity0.delays).to.be.undefined;

      const activity1 = request.activity[1];
      expect(activity1.attempts).to.equal(2);
      expect(activity1.delays.length).to.equal(1);
      expect(activity1.delays[0].retry).to.equal(request.options.retryDelay);
    }, err => {
      assert.fail();
    });
  });
});

function createRequest(responses, requestTracker = null) {
  // initialize the hook each time to ensure a fresh copy of the response table
  initializeRequestHook(responses, requestTracker);
  return new GitHubRequest({
    retryDelay: 10,
    forbiddenDelay: 15
  });
}

// hook the node request object to bypass the actual network sending and do the thing we want.
function initializeRequestHook(responseList, requestTracker = null) {
  const responses = responseList.slice();
  const hook = (options, callback) => {
    if (requestTracker) {
      requestTracker.push(options.url);
    }

    // finish the call in a timeout to simulate the network call context switch
    // callback(result.error, result.response, result.response.body);
    setTimeout(() => {
      result = responses.shift();
      callback(result.error, result.response, result.response.body);
    }, 0);
  };
  request.Request.request = hook;
}

function createSingleResponse(body, code = 200, remaining = 4000) {
  return {
    // error: null,
    response: {
      status: code,
      headers: {
        'x-ratelimit-remaining': remaining
      },
      body: body
    }
  }
}

function createMultiPageResponse(target, body, previous, next, last, code = 200, error = null, remaining = 4000) {
  return {
    error: error,
    response: {
      headers: {
        'x-ratelimit-remaining': remaining,
        link: createLinkHeader(target, previous, next, last)
      },
      status: code,
      body: body
    }
  };
}

function createErrorResponse(error) {
  return {
    error: error,
    response: {
      headers: {}
    }
  };
}

function createLinkHeader(target, previous, next, last) {
  separator = target.includes('?') ? '&' : '?';
  const firstLink = null; //`<${urlHost}/${target}${separator}page=1>; rel="first"`;
  const prevLink = previous ? `<${urlHost}/${target}${separator}page=${previous}>; rel="prev"` : null;
  const nextLink = next ? `<${urlHost}/${target}${separator}page=${next}>; rel="next"` : null;
  const lastLink = last ? `<${urlHost}/${target}${separator}page=${last}>; rel="last"` : null;
  return [firstLink, prevLink, nextLink, lastLink].filter(value => { return value !== null }).join(',');
}

