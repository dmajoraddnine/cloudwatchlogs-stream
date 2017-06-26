#!/usr/bin/env node

var stream = require('stream');
var util = require('util');
var minimist = require('minimist');
var debug = require('debug')('cloudwatchlogs');
var cwlogger = require('./cwlogger.js');

function CloudWatchLogsStream (opts) {
  debug('opts', opts);
  stream.Writable.call(this);
  this.logGroupName = opts.logGroupName;
  this.logStreamName = opts.logStreamName;
  this.bulkIndex = opts.bulkIndex || null;
  this.sequenceToken = null;
  this.cwlogger = cwlogger(opts);
  this.firstMsg = null;
  this.queue = [];
  this.timeout = opts.timeout ? Number(opts.timeout) * 1000 : null;
  this.timer = null;
  this.startTimer();

  var self = this;
  self.cwlogger.createLogGroup(self.logGroupName, function (err) {
    if (err) return self.emit('error', err);
    self.cwlogger.createLogStream(self.logGroupName, self.logStreamName, function (err, sequenceToken) {
      if (err) return self.emit('error', err);
      self.sequenceToken = sequenceToken;
      self._write = write;
      if (self.firstMsg) {
        self._write(self.firstMsg.chunk, self.firstMsg.encoding, self.firstMsg.done);
      }
    });
  });
};
util.inherits(CloudWatchLogsStream, stream.Writable);

function write (chunk, encoding, done) {
  var self = this;

  self.queue.push({
    message: chunk.toString(),
    timestamp: new Date().getTime()
  });

  // if we're not doing any batching, send now
  if (!self.bulkIndex && !self.timeout) return self.sendEvents();

  // if we're bulk batching and we've hit the batch limit, send now
  if (self.bulkIndex && self.queue.length > self.bulkIndex) return self.sendEvents(done);

  done();
}

CloudWatchLogsStream.prototype.sendEvents = function (cb) {
  var self = this;
  self.clearTimer();

  if (self.queue.length === 0) {
    self.startTimer();
    return setImmediate(cb);
  }

  var params = {
    logEvents: self.queue,
    logGroupName: self.logGroupName,
    logStreamName: self.logStreamName,
    sequenceToken: self.sequenceToken
  };

  this.cwlogger.putLogEvents(params, function (err, data) {
    if (err) {
      self.startTimer();
      return self.emit('error', err);
    }

    self.queue = [];
    self.sequenceToken = data.nextSequenceToken;
    self.startTimer();
    if (cb) cb();
  });
};

CloudWatchLogsStream.prototype.startTimer = function () {
  if (!this.timeout) return;

  this.timer = setTimeout(
    (function (self) {
      return function () {
        self.sendEvents();
      };
    })(this),
    this.timeout
  );
};

CloudWatchLogsStream.prototype.clearTimer = function () {
  if (this.timer) clearTimeout(this.timer);
};

CloudWatchLogsStream.prototype._write = function (chunk, encoding, done) {
  this.firstMsg = {
    chunk: chunk,
    encoding: encoding,
    done: done
  };
};

CloudWatchLogsStream.prototype.destroy = function (err) {
  this.clearTimer();
  if (err) this.emit('error', err);
  this.emit('close');
};

function main () {
  var argv = minimist(process.argv.slice(2), {
    alias: {
      'accessKeyId': 'a',
      'secretAccessKey': 's',
      'region': 'r',
      'logGroupName': 'g',
      'logStreamName': 't',
      'bulkIndex': 'b',
      'timeout': 'o'
    }
  });

  if (!(argv.accesskey || argv.secretkey || argv.groupname || argv.streamname || argv.region)) {
    console.log('Usage: cloudwatchlogs [-a ACCESS_KEY] [-s SECRET_KEY]\n' +
                '                      [-r REGION] [-g GROUP_NAME] [-t STREAM_NAME]\n' +
                '                      [-b BULK_INDEX] [-o TIMEOUT]');
    process.exit(1);
  }

  var str = new CloudWatchLogsStream(argv);
  process.stdin.pipe(str);
}

if (require.main === module) {
  main();
};

module.exports = CloudWatchLogsStream;
