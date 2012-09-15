(function(exports) {
// TODO(jeremya): properly surface all the log()s
var log = function(msg) { console.log(msg) }

// Calculate the CRC of a packet, for error checking.
function crc(data) {
  data = new Uint8Array(data);
  var crctab = [
    0, 94, 188, 226, 97, 63, 221, 131, 194, 156, 126, 32, 163, 253, 31, 65,
    157, 195, 33, 127, 252, 162, 64, 30, 95, 1, 227, 189, 62, 96, 130, 220,
    35, 125, 159, 193, 66, 28, 254, 160, 225, 191, 93, 3, 128, 222, 60, 98,
    190, 224, 2, 92, 223, 129, 99, 61, 124, 34, 192, 158, 29, 67, 161, 255,
    70, 24, 250, 164, 39, 121, 155, 197, 132, 218, 56, 102, 229, 187, 89, 7,
    219, 133, 103, 57, 186, 228, 6, 88, 25, 71, 165, 251, 120, 38, 196, 154,
    101, 59, 217, 135, 4, 90, 184, 230, 167, 249, 27, 69, 198, 152, 122, 36,
    248, 166, 68, 26, 153, 199, 37, 123, 58, 100, 134, 216, 91, 5, 231, 185,
    140, 210, 48, 110, 237, 179, 81, 15, 78, 16, 242, 172, 47, 113, 147, 205,
    17, 79, 173, 243, 112, 46, 204, 146, 211, 141, 111, 49, 178, 236, 14, 80,
    175, 241, 19, 77, 206, 144, 114, 44, 109, 51, 209, 143, 12, 82, 176, 238,
    50, 108, 142, 208, 83, 13, 239, 177, 240, 174, 76, 18, 145, 207, 45, 115,
    202, 148, 118, 40, 171, 245, 23, 73, 8, 86, 180, 234, 105, 55, 213, 139,
    87, 9, 235, 181, 54, 104, 138, 212, 149, 203, 41, 119, 244, 170, 72, 22,
    233, 183, 85, 11, 136, 214, 52, 106, 43, 117, 151, 201, 74, 20, 246, 168,
    116, 42, 200, 150, 21, 75, 169, 247, 182, 232, 10, 84, 215, 137, 107, 53
  ];
  var val = 0;
  for (var i = 0; i < data.length; i++) {
    var b = data[i];
    val = crctab[val ^ b];
  }
  return val;
}

function buildPacket(/* ArrayBuffer */ payload) {
  var buf = new ArrayBuffer(payload.byteLength + 3);
  var bv = new Uint8Array(buf);
  bv[0] = 0xd5; // magic
  bv[1] = payload.byteLength;
  bv.set(new Uint8Array(payload), 2);
  bv[2 + payload.byteLength] = crc(payload);
  return buf
}

///////////////////////////////////////////////////////////////////////////////
// A little state machine for reading responses off the serial line
function ResponseReader(cb) {
  this.state = 'magic'
  this.cb = cb
}
ResponseReader.prototype.data = function (buf) {
  var bv = new Uint8Array(buf);
  for (var i = 0; i < bv.length; i++) {
    this.byte(bv[i])
  }
}
ResponseReader.prototype.byte = function (b) {
  if (this.state == 'error') {
    throw "can't give bytes to an errored parser"
  } else if (this.state == 'done') {
    throw "can't give bytes to completed parser"
  } else if (this.state == 'magic') {
    if (b == 0xd5)
      this.state = 'length'
    else
      this.error('bad juju')
  } else if (this.state == 'length') {
    this.payloadBytesRemaining = b
    this.payload = new Uint8Array(new ArrayBuffer(b))
    this.state = 'payload'
  } else if (this.state == 'payload') {
    this.payload[this.payload.length-this.payloadBytesRemaining] = b
    this.payloadBytesRemaining--;
    if (this.payloadBytesRemaining == 0) {
      this.state = 'crc'
    }
  } else if (this.state == 'crc') {
    if (crc(this.payload.buffer) == b)
      this.done()
    else
      this.error('bad crc')
  }
}
ResponseReader.prototype.error = function (msg) {
  this.state = 'error'
  this.cb(msg)
}
ResponseReader.prototype.done = function () {
  this.state = 'done'
  this.cb(undefined, this.payload.buffer)
}
ResponseReader.prototype.pending = function () {
  return this.state != 'done' && this.state != 'error'
}
///////////////////////////////////////////////////////////////////////////////

function readResponse(id, cb) {
  var rr = new ResponseReader(cb)

  function readByte(cb) {
    chrome.serial.read(id, 1, function(info) {
      if (info.bytesRead == 0) {
        // TODO(jeremya): what does this mean?
      } else if (info.bytesRead != 1) {
        log("error: bytesRead is "+info.bytesRead)
        cb(info.bytesRead)
        return
      }
      cb(undefined, info.data)
    });
  }
  function step() {
    readByte(function(err, data) {
      if (err) throw err
      rr.data(data)
      if (rr.pending()) {
        step()
      }
    })
  }
  step()
}

function BakerMot() {
  this.connId = -1
}

// This makes sure only one command is running at a time. If you execute a
// command before the last one has finished, we'll buffer up the request and
// fire it off after the last callback is called.
var Command = function(fn) {
  return function() {
    var self = this
    if (arguments.length < 1 || typeof arguments[arguments.length-1] != 'function')
      throw "no callback given"
    var args = Array.prototype.slice.call(arguments, 0, arguments.length-1)
    var cb = arguments[arguments.length-1]
    var next = function() {
      try {
        cb.apply(undefined, arguments)
      } catch (e) {
        // TODO: break the queue if there's an error?
      }
      if (self.queue.length) {
        self.queue.shift().call(self)
      } else {
        self.queue = undefined
      }
    }
    args.push(next)

    if (typeof self.queue === 'undefined') {
      // no current action
      fn.apply(this, args)
      self.queue = []
    } else {
      self.queue.push(function() { return fn.apply(this, args) })
    }
  }
}

BakerMot.prototype.open = Command(function(cb) {
  var self = this
  chrome.serial.getPorts(function(ports) {
    log('connecting to ' + ports[0])
    chrome.serial.open(ports[0], {bitrate: 115200}, function(info) {
      self.connId = info.connectionId
      if (self.connId < 0) {
        log("failed to connect (connId = " + self.connId + ")")
        return cb('failed')
      }
      cb()
    })
  })
})

BakerMot.prototype._send_command = Command(function(payload, cb) {
  var p = buildPacket(payload)
  var self = this
  chrome.serial.write(self.connId, p, function(info) {
    if (info.bytesWritten != p.byteLength) {
      log('error writing data: length = '+payload.byteLength+', bytesWritten = '+info.bytesWritten)
      return cb('short write or error: '+info.bytesWritten)
    }
    chrome.serial.flush(self.connId, function(res) {
      if (!res) {
        log("ERR: couldn't flush, is something up? continuing anyway..")
      }
      readResponse(self.connId, function(err, resp) {
        if (err) return cb('error reading response: '+err)
        var data = new DataView(resp)
        cb(undefined, data)
      })
    })
  })
})

// Helper function for building payloads. Usage:
//   cmd(142).s32(x).s32(y).s32(z).s32(a).s32(b).u32(duration).u8(flags).buffer
function Builder(bigEndian) {
  this.littleEndian = !bigEndian
  this.data = [];
  this.size = 0;
}

var sizes = {s32:4, u32:4, s16:2, u16:2, s8:1, u8:1, f32:4, f64:8};
var setfns = {
  s32:'setUint32', u32:'setInt32',
  s16:'setInt16', u16:'setUint16',
  s8:'setInt8', u8:'setUint8',
  f32:'setFloat32', f64:'setFloat64',
};

var getfns = {
  s32:'getUint32', u32:'getInt32',
  s16:'getInt16', u16:'getUint16',
  s8:'getInt8', u8:'getUint8',
  f32:'getFloat32', f64:'getFloat64',
};

['s32','u32','s16','u16','s8','u8','f32','f64'].forEach(function(n) {
  Builder.prototype[n] = function(i) { this.data.push([n,i]); this.size += sizes[n]; return this; };
});

Builder.prototype.__defineGetter__('buffer', function() {
  var payload = new DataView(new ArrayBuffer(this.size));
  var offset = 0;
  for (var i in this.data) {
    var d = this.data[i];
    payload[setfns[d[0]]](offset, d[1], this.littleEndian);
    offset += sizes[d[0]];
  }
  return payload;
})

var unbuild = function (buf, str, bigEndian) {
  var dv = buf instanceof DataView ? buf : new DataView(buf)
  var obj = {}
  var offset = 0
  str.split(/;/).forEach(function (s) {
    var m = /(\w+)\s+(\w+)/.exec(s)
    obj[m[2]] = dv[getfns[m[1]]](offset, !bigEndian);
    offset += sizes[m[1]];
  })
  return obj
}

function cmd(id) {
  return (new Builder).u8(id)
}

BakerMot.prototype.get_version = function(cb) {
  var payload = cmd(0).u16(/* host version */ 100)
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    var res = unbuild(data, 'u16 version')
    cb(undefined, res.version)
  })
}

// reset axis positions to 0, clear command buffer
BakerMot.prototype.init = function(cb) {
  var payload = cmd(1)
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb(undefined)
  })
}

BakerMot.prototype.abort = function(cb) {
  var payload = cmd(7)
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb(undefined)
  })
}

BakerMot.prototype.get_name = function(cb) {
  // only works for v5.5, hardcoded. TODO(jeremya) eeprom maps.
  var payload = cmd(12).u16(/* offset */ 0x0022).u8(/* length */ 16)
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    var name = ''
    for (var i = 1; i < data.byteLength; i++) {
      var char = data.getUint8(i)
      if (char == 0) break;
      name += String.fromCharCode(data.getUint8(i));
    }
    cb(undefined, name)
  })
}

BakerMot.prototype.find_axes_minima = function(axes, rate, timeout, cb) {
  var payload = cmd(131)
    .u8(axes)     // axis bitfield
    .u32(rate)    // feedrate, microseconds between steps on max delta
    .u16(timeout) // timeout, seconds
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb()
  })
}

BakerMot.prototype.find_axes_maxima = function(axes, rate, timeout, cb) {
  var payload = cmd(132)
    .u8(axes)     // axis bitfield
    .u32(rate)    // feedrate, microseconds between steps on max delta
    .u16(timeout) // timeout, seconds
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb()
  })
}

BakerMot.prototype.toggle_axes = function(axes, enable, cb) {
  var payload = cmd(137)
    .u8((axes & 0x7f) | ((enable ? 1 : 0) << 7)) // axis bitfield, high bit is enable/disable
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb()
  })
}

BakerMot.prototype.get_position = function(cb) {
  var payload = cmd(21)
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    var res = unbuild(data, 's32 x; s32 y; s32 z; s32 a; s32 b; u16 endstops')
    cb(undefined, res)
  })
}

BakerMot.prototype.queue_point = function(x,y,z,a,b,dur,cb) {
  var payload = cmd(142)
    .s32(x)  // axes, in steps
    .s32(y)
    .s32(z)
    .s32(a)
    .s32(b)
    .u32(dur) // duration, microseconds
    .u8(0xff) // bitfield, 1 for relative, 0 for absolute
  this._send_command(payload.buffer, function(err, data) {
    cb(err)
  })
}

exports.BakerMot = BakerMot
})(window.bm = {})
