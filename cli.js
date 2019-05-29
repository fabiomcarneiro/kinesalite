#!/usr/bin/env node

var server = require('./server'),
    argv = require('minimist')(process.argv.slice(2))

if (argv.help) {
  return console.log([
    '',
    'Usage: kinesalite [--port <port>] [--path <path>] [--ssl] [options]',
    '',
    'A Kinesis http server, optionally backed by LevelDB',
    '',
    'Options:',
    '--help                 Display this help message and exit',
    '--port <port>          The port to listen on (default: 4567)',
    '--path <path>          The path to use for the LevelDB store (in-memory by default)',
    '--ssl                  Enable SSL for the web server (default: false)',
    '--createStreamMs <ms>  Amount of time streams stay in CREATING state (default: 500)',
    '--deleteStreamMs <ms>  Amount of time streams stay in DELETING state (default: 500)',
    '--updateStreamMs <ms>  Amount of time streams stay in UPDATING state (default: 500)',
    '--shardLimit <limit>   Shard limit for error reporting (default: 10)',
    '',
    'Report bugs at github.com/mhart/kinesalite/issues',
  ].join('\n'))
}

// If we're PID 1, eg in a docker container, SIGINT won't end the process as usual
if (process.pid == 1) process.on('SIGINT', process.exit)

server.startServer(argv)


