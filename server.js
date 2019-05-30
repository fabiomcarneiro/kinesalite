var url = require('url'),
    crypto = require('crypto'),
    uuid = require('uuid'),
    validations = require('./validations'),
    db = require('./db/index.js'),
    https = require('https'),
    http = require('http'),
    http2 = require('http2'),
    fs = require('fs'),
    path = require('path')

module.exports = {
    startServer: startServer,
    sendRaw: sendRaw,
    sendJson: sendJson,
    sendCborUnknown: sendCborUnknown,
    sendCborSerialization: sendCborSerialization,
    sendError: sendError,
    httpHandler: httpHandler,
    getDBInfo: getDBInfo,
}

var MAX_REQUEST_BYTES = 7 * 1024 * 1024
var validApis = ['Kinesis_20131202']

var httpOperations = ['AddTagsToStream', 'CreateStream', 'DeleteStream', 'DescribeStream', 'GetRecords',
      'GetShardIterator', 'ListShards', 'ListStreams', 'ListTagsForStream', 'MergeShards', 'PutRecord', 'PutRecords',
      'RemoveTagsFromStream', 'SplitShard', 'IncreaseStreamRetentionPeriod', 'DecreaseStreamRetentionPeriod']

var http2Operations = ['SubscribeToShard']


var http2Actions = [], httpActions = [], actionValidations = {}



function serverHTTP(options) {
  options = options || {}
  var server, store = db.create(options), requestHandler = httpHandler.bind(null, store)

  if (options.ssl) {
    options.key = options.key || fs.readFileSync(path.join(__dirname, 'ssl', 'server-key.pem'))
    options.cert = options.cert || fs.readFileSync(path.join(__dirname, 'ssl', 'server-crt.pem'))
    options.ca = options.ca || fs.readFileSync(path.join(__dirname, 'ssl', 'ca-crt.pem'))
    server = https.createServer(options, requestHandler)
  } else {
    server = http.createServer(requestHandler)
  }

  // Ensure we close DB when we're closing the se rver too
  var httpServerClose = server.close, httpServerListen = server.listen
  server.close = function(cb) {
    store.db.close(function(err) {
      if (err) return cb(err)
      // Recreate the store if the user wants to listen again
      server.listen = function() {
        store.recreate()
        httpServerListen.apply(_server, arguments)
      }
      httpServerClose.call(_server, cb)
    })
  }
  return server
}


function serverHTTP2(options) {
  options = options || {}
  var store = getDBInfo(), requestHandler = httpHandler.bind(null, store)
  var server2 = http2.createSecureServer(
      {
        key: options.key || fs.readFileSync(path.join(__dirname, 'ssl', 'server-key.pem')),
        cert: options.cert || fs.readFileSync(path.join(__dirname, 'ssl', 'server-crt.pem')),
        ca: options.ca || fs.readFileSync(path.join(__dirname, 'ssl', 'ca-crt.pem')),
      }
    )

  // Ensure we close DB when we're closing the se rver too
  var httpServerClose = server2.close, httpServerListen = server2.listen
  server2.close = function(cb) {
    store.db.close(function(err) {
      if (err) return cb(err)
      // Recreate the store if the user wants to listen again
      server2.listen = function() {
        store.recreate()
        httpServerListen.apply(server, arguments)
      }
      httpServerClose.call(server, cb)
      return 0
    })
  }
  return server2
}






function sendRaw(req, res, body, statusCode) {
  req.removeAllListeners()
  res.statusCode = statusCode || 200
  if (body != null) {
    res.setHeader(
      'Content-Length',
      Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, 'utf8')
    )
  }
  // AWS doesn't send a 'Connection' header but seems to use keep-alive behaviour
  // res.setHeader('Connection', '')
  // res.shouldKeepAlive = false
  res.end(body)
}

function sendJson(req, res, data, statusCode) {
  var body = data != null ? JSON.stringify(data) : ''
  res.setHeader('Content-Type', res.contentType)
  sendRaw(req, res, body, statusCode)
}

function sendCborUnknown(req, res) {
  res.setHeader('Content-Type', 'application/x-amz-cbor-1.1')
  return sendRaw(
    req,
    res,
    Buffer.concat([
      new Buffer('bf66', 'hex'),
      new Buffer('__type', 'utf8'),
      new Buffer('7819', 'hex'),
      new Buffer('UnknownOperationException', 'utf8'),
      new Buffer('ff', 'hex'),
    ]),
    400
  )
}

function sendCborSerialization(req, res) {
  res.setHeader('Content-Type', 'application/x-amz-cbor-1.1')
  return sendRaw(
    req,
    res,
    Buffer.concat([
      new Buffer('bf66', 'hex'),
      new Buffer('__type', 'utf8'),
      new Buffer('76', 'hex'),
      new Buffer('SerializationException', 'utf8'),
      new Buffer('ff', 'hex'),
    ]),
    400
  )
}

function sendError(req, res, contentValid, type, msg) {
  return contentValid ?
    sendJson(req, res, {__type: type, message: msg}, 400) :
    typeof msg == 'number' ?
    sendRaw(req, res, '<' + type + '/>\n', msg) :
    sendRaw(
        req,
        res,
        '<' + type + '>\n  <Message>' + msg + '</Message>\n</' + type + '>\n',
        403
      )
}

function httpHandler(store, req, res) {
  var body
  req.on('error', function(err) {
    throw err
  })
  req.on('data', function(data) {
    var newLength = data.length + (body ? body.length : 0)
    if (newLength > MAX_REQUEST_BYTES) {
      res.setHeader('Transfer-Encoding', 'chunked')
      return sendRaw(req, res, null, 413)
    }
    body = body ? Buffer.concat([body, data], newLength) : data
  })
  req.on('end', function() {
    body = body ? body.toString() : ''

    // All responses after this point have a RequestId
    res.setHeader('x-amzn-RequestId', uuid.v1())
    if (req.method != 'OPTIONS' || !req.headers.origin)
      res.setHeader('x-amz-id-2', crypto.randomBytes(72).toString('base64'))

    // FIRST check if we've got an origin header:

    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', '*')

      // If it's a valid OPTIONS call, return here
      if (req.method == 'OPTIONS') {
        if (req.headers['access-control-request-headers'])
          res.setHeader(
            'Access-Control-Allow-Headers',
            req.headers['access-control-request-headers']
          )

        if (req.headers['access-control-request-method'])
          res.setHeader(
            'Access-Control-Allow-Methods',
            req.headers['access-control-request-method']
          )

        res.setHeader('Access-Control-Max-Age', 172800)
        return sendRaw(req, res, '')
      }

      res.setHeader(
        'Access-Control-Expose-Headers',
        'x-amzn-RequestId,x-amzn-ErrorType,x-amz-request-id,x-amz-id-2,x-amzn-ErrorMessage,Date'
      )
    }

    if (req.method != 'POST') {
      return sendError(
        req,
        res,
        false,
        'AccessDeniedException',
        'Unable to determine service/operation name to be authorized'
      )
    }

    var contentType = (req.headers['content-type'] || '').split(';')[0].trim()
    var contentValid = ~[
      'application/x-amz-json-1.1',
      'application/json',
    ].indexOf(contentType)

    var target = (req.headers['x-amz-target'] || '').split('.')
    var service = target[0]
    var operation = target[1]
    var serviceValid = service && ~validApis.indexOf(service)
    var operationValid = operation && ~httpOperations.indexOf(operation)

    // AWS doesn't seem to care about the HTTP path, so no checking needed for that

    // THEN if the method and content-type are ok, see if the JSON parses:

    if (!body) {
      if (contentType == 'application/x-amz-json-1.1') {
        res.contentType = 'application/x-amz-json-1.1'
        return sendJson(
          req,
          res,
          {
            __type:
              serviceValid && operationValid ?
                'SerializationException' :
                'UnknownOperationException',
          },
          400
        )
      }

      res.setHeader('Content-Type', 'application/x-amz-cbor-1.1')
      return serviceValid && operationValid ?
        sendCborSerialization(req, res) :
        sendCborUnknown(req, res)
    }

    if (!contentValid) {
      if (!service || !operation) {
        return sendError(
          req,
          res,
          false,
          'AccessDeniedException',
          'Unable to determine service/operation name to be authorized'
        )
      }
      return sendError(req, res, false, 'UnknownOperationException', 404)
    }

    res.contentType = contentType

    var data
    try {
      data = JSON.parse(body)
    } catch (e) {}

    if (typeof data != 'object' || data == null) {
      if (contentType == 'application/json') {
        return sendJson(
          req,
          res,
          {
            Output: {
              __type: 'com.amazon.coral.service#SerializationException',
              Message: null,
            },
            Version: '1.0',
          },
          200
        )
      }
      return sendJson(req, res, {__type: 'SerializationException'}, 400)
    }

    // After this point, application/json doesn't seem to progress any further
    if (contentType == 'application/json') {
      return sendJson(
        req,
        res,
        {
          Output: {
            __type: 'com.amazon.coral.service#UnknownOperationException',
            message: null,
          },
          Version: '1.0',
        },
        200
      )
    }

    if (!serviceValid || !operationValid) {
      return sendJson(req, res, {__type: 'UnknownOperationException'}, 400)
    }

    // THEN check auth:

    var authHeader = req.headers.authorization
    var query = ~req.url.indexOf('?') ? url.parse(req.url, true).query : {}
    var authQuery = 'X-Amz-Algorithm' in query
    var msg = '',
      params

    if (authHeader && authQuery) {
      return sendError(
        req,
        res,
        contentValid,
        'InvalidSignatureException',
        "Found both 'X-Amz-Algorithm' as a query-string param and 'Authorization' as HTTP header."
      )
    }

    if (!authHeader && !authQuery) {
      return sendError(
        req,
        res,
        contentValid,
        'MissingAuthenticationTokenException',
        'Missing Authentication Token'
      )
    }

    if (authHeader) {
      params = ['Credential', 'Signature', 'SignedHeaders']
      var authParams = authHeader
        .split(/,| /)
        .slice(1)
        .filter(Boolean)
        .reduce(function(obj, x) {
          var keyVal = x.trim().split('=')
          obj[keyVal[0]] = keyVal[1]
          return obj
        }, {})
      params.forEach(function(param) {
        if (!authParams[param])
          msg += "Authorization header requires '" + param + "' parameter. "
      })
      if (!req.headers['x-amz-date'] && !req.headers.date)
        msg +=
          "Authorization header requires existence of either a 'X-Amz-Date' or a 'Date' header. "
      if (msg) msg += 'Authorization=' + authHeader
    } else {
      params = [
        'X-Amz-Algorithm',
        'X-Amz-Credential',
        'X-Amz-Signature',
        'X-Amz-SignedHeaders',
        'X-Amz-Date',
      ]
      params.forEach(function(param) {
        if (!query[param])
          msg += "AWS query-string parameters must include '" + param + "'. "
      })
      if (msg) msg += 'Re-examine the query-string parameters.'
    }

    if (msg) {
      return sendError(
        req,
        res,
        contentValid,
        'IncompleteSignatureException',
        msg
      )
    }
    actionDispatch(store, req, res, data, operation)
  })
}


function getDBInfo() {
    return db.dbDetails
}


function actionDispatch(store, req, res, data, operation) {

    var action = validations.toLowerFirst(operation)
    var actionValidation = actionValidations[action]
    try {
      data = validations.checkTypes(data, actionValidation.types)
      validations.checkValidations(
        data,
        actionValidation.types,
        actionValidation.custom,
        operation
      )
    } catch (e) {
      if (e.statusCode) return sendJson(req, res, e.body, e.statusCode)
      throw e
    }

    var executionAction
    if (http2Actions.includes(action)) {
      executionAction = http2Actions[action]
    }else{
      executionAction = httpActions[action]
    }
    executionAction(store, data, function(err, data) {
      if (err && err.statusCode)
        return sendJson(req, res, err.body, err.statusCode)
      if (err) throw err
        return sendJson(req, res, data)
    })

}


function startServer(options) {

  var localServ = serverHTTP(options).listen(options.port || 4567, function() {
    var address = localServ.address(), protocol = options.ssl ? 'https' : 'http'
    console.log('Listening HTTP server at %s://%s:%s', protocol, address.address, address.port)
  })

  var localServ2 = serverHTTP2(options).listen(options.port + 1 || 4568, function() {
    var address = localServ2.address(), protocol = options.ssl ? 'https' : 'http'
    console.log('Listening HTTP/2 server at %s://%s:%s', protocol, address.address, address.port)
  })

  httpOperations.forEach(function(action) {
    action = validations.toLowerFirst(action)
    httpActions[action] = require('./actions/' + action)
    actionValidations[action] = require('./validations/' + action)
  })

  /*
  http2Operations.forEach(function(action) {
    action = validations.toLowerFirst(action)
    http2Actions[action] = require('./actions/' + action)
    actionValidations[action] = require('./validations/' + action)
  }) */

}
