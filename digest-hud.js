angular.module('digestHud', [])

.provider('digestHud', ['$provide', function($provide) {
  'use strict';

  function WatchTiming(key) {
    this.key = key;
    this.reset();
  }

  WatchTiming.prototype.reset = function() {
    this.watch = 0;
    this.handle = 0;
    this.overhead = 0;
    this.total = 0;
    this.cycleTotal = 0;
    this.cycleStart = null;
    this.subTotal = 0;
  };

  WatchTiming.prototype.startCycle = function(start) {
    timingStack.push(this);
    this.cycleStart = start;
    this.cycleTotal = 0;
    this.subTotal = 0;
  };

  WatchTiming.prototype.countTime = function(counter, duration) {
    this[counter] += duration - this.subTotal;
    this.cycleTotal += duration;
    this.subTotal = 0;
  };

  WatchTiming.prototype.endCycle = function() {
    if (!this.cycleStart) return;
    var duration = Date.now() - this.cycleStart;
    this.overhead += duration - this.cycleTotal;
    this.cycleStart = null;
    timingStack.pop();
    if (timingStack.length) {
      timingStack[timingStack.length - 1].subTotal += duration;
    } else {
      overheadTiming.overhead -= duration;
    }
  };

  WatchTiming.prototype.sum = function() {
    this.total = this.watch + this.handle + this.overhead;
  };

  WatchTiming.prototype.format = function(grandTotal) {
    return percentage(this.total / grandTotal) + '\u2003(' +
      percentage(this.watch / grandTotal) + ' + ' +
      percentage(this.handle / grandTotal) + ' + ' +
      percentage(this.overhead / grandTotal) +
      ')\u2003' + this.key;
  };

  function flushTimingCycle() {
    if (timingStack.length) timingStack[timingStack.length - 1].endCycle();
  }

  var digestTimings = [];
  var watchTimings = {};
  var timingStack;
  var overheadTiming = createTiming('$$ng-overhead');
  var digestHud = this;
  var inDigest = false;
  var hudElement;
  var defaultHudPosition = 'bottom right';
  var customHudPosition;
  var $parse;

  this.numTopWatches = 20;
  this.numDigestStats = 25;

  this.enable = function() {
    var toggle = false;
    var detailsText = '';

    hudElement = $('<div></div>');
    var buttonsElement = $(
      '<div>' +
      '<span id="digestHud-refresh">refresh</span> &bull; ' +
      '<span id="digestHud-reset">reset</span> ' +
      '</div>').appendTo(hudElement);
    var summaryElement = $('<div></div>').appendTo(hudElement);
    var detailsElement = $('<div></div>').appendTo(hudElement);
    var showDetails = false;
    hudElement.on('click', function() {
      showDetails = !showDetails;
      buttonsElement.toggle(showDetails);
      detailsElement.toggle(showDetails);
      if (showDetails) refreshDetails();
    });

    hudElement.on('copy', function(ev) {
      ev.originalEvent.clipboardData.setData('text/plain', detailsText);
      ev.preventDefault();
    });

    buttonsElement.find('#digestHud-refresh').on('click', refreshDetails);
    buttonsElement.find('#digestHud-reset').on('click', resetTimings);
    buttonsElement.on('click', function(ev) {ev.stopPropagation();});

    hudElement.on('mousedown mouseup click', function(ev) {ev.stopPropagation();});
    hudElement.css({
      position: 'fixed',
      backgroundColor: 'rgba(0, 0, 0, 0.65)',
      color: 'white',
      padding: '2px 5px',
      fontSize: 'small',
      cursor: 'default',
      zIndex: '1000000'
    });

    this.setHudPosition(customHudPosition || defaultHudPosition);

    buttonsElement.css({
      float: 'right',
      display: 'none'
    });
    buttonsElement.children().css({
      cursor: 'pointer'
    });
    detailsElement.css({
      whiteSpace: 'pre',
      minWidth: '30em',
      maxWidth: '50em',
      display: 'none'
    });
    $('body').append(hudElement);

    function refreshDetails() {
      var grandTotal = 0, topTotal = 0;

      var topWatchTimings = Object.keys(watchTimings).map(function(k){
        return watchTimings[k];
      }).map(function(timing) {
        timing.sum(); grandTotal += timing.total;
        return timing;
      }).sort(function(a, b) {
        var x = a.total; var y = b.total;
         return ((x < y) ? 1 : ((x > y) ? -1 : 0));
      }).slice(0, digestHud.numTopWatches);

      var lines = topWatchTimings.map(function(timing) {
        topTotal += timing.total;
        return timing.format(grandTotal);
      });
      var rows = lines.map(function(text) {
        var row = $('<div></div>');
        row.css({
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        });
        row.text(text.replace(/[ \n]+/g, ' '));
        row.attr('title', text.slice(29));
        return row;
      });
      detailsElement.empty();
      $('<div>\u2007Total\u2007\u2007\u2007Watch\u2007Work\u2007Overhead\u2007\u2007Function</div>')
        .css({borderBottom: '1px solid'}).appendTo(detailsElement);
      detailsElement.append(rows);
      var footer = 'Top ' + topWatchTimings.length + ' items account for ' +
        percentage(topTotal / grandTotal) + ' of ' + grandTotal + 'ms of digest processing time.';
      $('<div></div>').text(footer).appendTo(detailsElement);
      detailsText = 'Total  Watch   Work Overhead  Function\n' + lines.map(function(text) {
        return text.replace(/[ \n]+/g, ' ');
      }).join('\n') + '\n' + footer + '\n';
    }

    function resetTimings() {
      digestTimings = [];

      Object.keys(watchTimings).map(function(k){
        return watchTimings[k];
      }).forEach(function(watchTiming) {
        watchTiming.reset();
      });
    }

    $provide.decorator('$rootScope', ['$delegate', function($delegate) {
      var proto = Object.getPrototypeOf($delegate);
      var originalDigest = proto.$digest;
      var originalEvalAsync = proto.$evalAsync;
      var originalApplyAsync = proto.$applyAsync;
      var originalPostDigest = proto.$$postDigest;
      var originalWatch = proto.$watch;
      var originalWatchGroup = proto.$watchGroup;
      // $watchCollection delegates to $watch, no extra processing necessary
      proto.$digest = instrumentedDigest;
      proto.$evalAsync = instrumentedEvalAsync;
      proto.$applyAsync = instrumentedApplyAsync;
      proto.$$postDigest = instrumentedPostDigest;
      proto.$watch = instrumentedWatch;
      proto.$watchGroup = instrumentedWatchGroup;

      var watchTiming;

      function instrumentedDigest() {
        // jshint validthis:true
        timingStack = [];
        this.$$postDigest(flushTimingCycle);
        var start = Date.now();
        inDigest = true;
        try {
          originalDigest.call(this);
        } finally {
          inDigest = false;
        }
        var duration = Date.now() - start;
        overheadTiming.overhead += duration;
        toggle = !toggle;
        digestTimings.push(duration);
        if (digestTimings.length > digestHud.numDigestStats) digestTimings.shift();
        var len = digestTimings.length;
        var sorted = digestTimings.slice().sort(function(a, b) {return a - b;});
        var median = len % 2 ?
          sorted[(len - 1) / 2] : Math.round((sorted[len / 2] + sorted[len / 2 - 1]) / 2);
        var description =
          'digest ' + sorted[0] + 'ms ' + median + 'ms ' + sorted[len - 1] + 'ms ' +
          (toggle ? '\u25cf' : '\u25cb');
        summaryElement.text(description);
      }

      function instrumentedEvalAsync(expression, locals) {
        // jshint validthis:true
        var timing = createTiming('$evalAsync(' + formatExpression(expression) + ')');
        originalEvalAsync.call(
          this, wrapExpression(expression, timing, 'handle', true, true), locals);
      }

      function instrumentedApplyAsync(expression) {
        // jshint validthis:true
        var timing = createTiming('$applyAsync(' + formatExpression(expression) + ')');
        originalApplyAsync.call(this, wrapExpression(expression, timing, 'handle', false, true));
      }

      function instrumentedPostDigest(fn) {
        // jshint validthis:true
        if (timingStack.length) {
          fn = wrapExpression(fn, timingStack[timingStack.length - 1], 'overhead', true, true);
        }
        originalPostDigest.call(this, fn);
      }

      function instrumentedWatch(watchExpression, listener, objectEquality) {
        // jshint validthis:true
        var watchTimingSet = false;
        if (!watchTiming) {
          // Capture watch timing (and its key) once, before we descend in $$watchDelegates.
          watchTiming = createTiming(formatExpression(watchExpression));
          watchTimingSet = true;
        }
        try {
          if (angular.isString(watchExpression)) {
            if (!$parse) {
              angular.injector(['ng']).invoke(['$parse', function(parse) {$parse = parse;}]);
            }
            watchExpression = $parse(watchExpression);
          }
          if (watchExpression && watchExpression.$$watchDelegate) {
            return originalWatch.call(this, watchExpression, listener, objectEquality);
          } else {
            return originalWatch.call(
              this, wrapExpression(watchExpression, watchTiming, 'watch', true, false),
              wrapListener(listener, watchTiming), objectEquality);
          }
        } finally {
          if (watchTimingSet) watchTiming = null;
        }
      }

      function instrumentedWatchGroup(watchExpressions, listener) {
        // jshint validthis:true
        var watchTimingSet = false;
        if (!watchTiming) {
          // $watchGroup delegates to $watch for each expression, so just make sure to set the group's
          // aggregate key as the override first.
          watchTiming = createTiming(
            '[' + watchExpressions.map(formatExpression).join(', ') + ']');
          watchTimingSet = true;
        }
        try {
          return originalWatchGroup.call(this, watchExpressions, listener);
        } finally {
          if (watchTimingSet) watchTiming = null;
        }
      }

      return $delegate;
    }]);

    $provide.decorator('$parse', ['$delegate', function($delegate) {
      return function(expression) {
        var result = $delegate.apply(this, arguments);
        if (angular.isString(expression)) result.exp = expression;
        return result;
      };
    }]);

    $provide.decorator('$q', ['$delegate', function($delegate) {
      var proto = Object.getPrototypeOf($delegate.defer().promise);
      var originalThen = proto.then;
      var originalFinally = proto.finally;
      proto.then = instrumentedThen;
      proto.finally = instrumentedFinally;

      function instrumentedThen(onFulfilled, onRejected, progressBack) {
        // jshint validthis:true
        return originalThen.call(
          this,
          wrapExpression(
            onFulfilled, createTiming('$q(' + formatExpression(onFulfilled) + ')'), 'handle',
            false, true),
          wrapExpression(
            onRejected, createTiming('$q(' + formatExpression(onRejected) + ')'), 'handle',
            false, true),
          wrapExpression(
            progressBack, createTiming('$q(' + formatExpression(progressBack) + ')'), 'handle',
            false, true)
        );
      }

      function instrumentedFinally(callback, progressBack) {
        // jshint validthis:true
        return originalFinally.call(
          this,
          wrapExpression(
            callback, createTiming('$q(' + formatExpression(callback) + ')'), 'handle',
            false, true),
          wrapExpression(
            progressBack, createTiming('$q(' + formatExpression(callback) + ')'), 'handle',
            false, true)
        );
      }

      return $delegate;
    }]);

    var originalBind = angular.bind;
    angular.bind = function(self, fn, args) {
      var result = originalBind.apply(this, arguments);
      result.exp = formatExpression(fn);
      return result;
    };
  };

  this.setHudPosition = function(position) {
    if (hudElement) {
      // reset all to defaults
      var styles = {
        top: 'auto',
        right: 'auto',
        bottom: 'auto',
        left: 'auto'
      };
      position = position ? '' + position : defaultHudPosition;
      position.split(' ').map(function(prop) { styles[prop] = 0; });
      hudElement.css(styles);
    } else {
      // save and apply on enabled
      customHudPosition = position;
    }
  };

  function percentage(value) {
    if (value >= 1) return (value * 100).toFixed(1) + '%';
    return ('\u2007\u2007' + (value * 100).toFixed(1) + '%').slice(-5);
  }

  function formatExpression(watchExpression) {
    if (!watchExpression) return '';
    if (angular.isString(watchExpression)) return watchExpression;
    if (angular.isString(watchExpression.exp)) return watchExpression.exp;
    if (watchExpression.name) return 'function ' + watchExpression.name + '() {\u2026}';
    return watchExpression.toString();
  }

  function wrapExpression(expression, timing, counter, flushCycle, endCycle) {
    if (!expression && !flushCycle) return expression;
    if (!$parse) angular.injector(['ng']).invoke(['$parse', function(parse) {$parse = parse;}]);
    var actualExpression = angular.isString(expression) ? $parse(expression) : expression;
    return function instrumentedExpression() {
      if (flushCycle) flushTimingCycle();
      if (!actualExpression) return;
      if (!inDigest) return actualExpression.apply(this, arguments);
      var start = Date.now();
      timing.startCycle(start);
      try {
        return actualExpression.apply(this, arguments);
      } finally {
        timing.countTime(counter, Date.now() - start);
        if (endCycle) timing.endCycle();
      }
    };
  }

  function wrapListener(listener, timing) {
    if (!listener) return listener;
    return function instrumentedListener() {
      var start = Date.now();
      try {
        return listener.apply(this, arguments);
      } finally {
        timing.countTime('handle', Date.now() - start);
      }
    };
  }

  function createTiming(key) {
    var timing = watchTimings[key];
    if (!timing) timing = watchTimings[key] = new WatchTiming(key);
    return timing;
  }

  this.$get = function() {};
}]);

