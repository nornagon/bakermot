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
  // TODO(jeremya): keep a queue of commands so we can pretend to be
  // synchronous.
  this.busy = false
}

BakerMot.prototype.open = function(cb) {
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
}

BakerMot.prototype._send_command = function(payload, cb) {
  if (this.busy) throw 'one at a time, fellas!'
  this.busy = true
  var p = buildPacket(payload)
  var self = this
  chrome.serial.write(self.connId, p, function(info) {
    if (info.bytesWritten != p.byteLength) {
      log('error writing data: length = '+payload.byteLength+', bytesWritten = '+info.bytesWritten)
      self.busy = false;
      return cb('short write or error: '+info.bytesWritten)
    }
    chrome.serial.flush(self.connId, function(res) {
      if (!res) {
        log("ERR: couldn't flush, is something up? continuing anyway..")
      }
      readResponse(self.connId, function(err, resp) {
        self.busy = false;
        if (err) return cb('error reading response: '+err)
        var data = new DataView(resp)
        cb(undefined, data)
      })
    })
  })
}

BakerMot.prototype.get_version = function(cb) {
  var payload = new DataView(new ArrayBuffer(3))
  payload.setUint8(0, 0x00); // command
  payload.setUint16(1, 100, true); // host version
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb(undefined, data.getUint16(1, true))
  })
}

// reset axis positions to 0, clear command buffer
BakerMot.prototype.init = function(cb) {
  var payload = new DataView(new ArrayBuffer(1))
  payload.setUint8(0, 0x01); // command
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb(undefined)
  })
}

BakerMot.prototype.abort = function(cb) {
  var payload = new DataView(new ArrayBuffer(1))
  payload.setUint8(0, 0x07); // command
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb(undefined)
  })
}

BakerMot.prototype.get_name = function(cb) {
  // only works for v5.5, hardcoded. TODO(jeremya) eeprom maps.
  var payload = new DataView(new ArrayBuffer(4))
  payload.setUint8(0, 12); // command
  payload.setUint16(1, 0x0022, true); // offset
  payload.setUint8(3, 16); // length
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
  var payload = new DataView(new ArrayBuffer(8))
  payload.setUint8(0, 131); // command
  payload.setUint8(1, axes); // axis bitfield
  payload.setUint32(2, rate, true); // feedrate, us between steps on max delta
  payload.setUint16(6, timeout); // timeout, seconds
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb()
  })
}

BakerMot.prototype.find_axes_maxima = function(axes, rate, timeout, cb) {
  var payload = new DataView(new ArrayBuffer(8))
  payload.setUint8(0, 132); // command
  payload.setUint8(1, axes); // axis bitfield
  payload.setUint32(2, rate, true); // feedrate, us between steps on max delta
  payload.setUint16(6, timeout); // timeout, seconds
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb()
  })
}

BakerMot.prototype.toggle_axes = function(axes, enable, cb) {
  var payload = new DataView(new ArrayBuffer(2))
  payload.setUint8(0, 137); // command
  payload.setUint8(1, (axes & 0x7f) | ((enable ? 1 : 0) << 7)); // axis bitfield
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    cb()
  })
}

BakerMot.prototype.get_position = function(cb) {
  var payload = new DataView(new ArrayBuffer(1))
  payload.setUint8(0, 21); // command
  this._send_command(payload.buffer, function(err, data) {
    if (err) return cb(err)
    var x_pos_steps = data.getInt32(0, true)
    var y_pos_steps = data.getInt32(4, true)
    var z_pos_steps = data.getInt32(8, true)
    var a_pos_steps = data.getInt32(12, true)
    var b_pos_steps = data.getInt32(16, true)
    var endstop_status = data.getUint16(20, true)
    cb(undefined, {
      x: x_pos_steps,
      y: y_pos_steps,
      z: z_pos_steps,
      a: a_pos_steps,
      b: b_pos_steps,
      endstops: endstop_status,
    })
  })
}

BakerMot.prototype.queue_point = function(x,y,z,a,b,dur,cb) {
  var payload = new DataView(new ArrayBuffer(26))
  payload.setUint8(0, 142); // command
  payload.setInt32(1, x, true);
  payload.setInt32(5, y, true);
  payload.setInt32(9, z, true);
  payload.setInt32(13, a, true);
  payload.setInt32(17, b, true);
  payload.setUint32(21, dur, true);
  payload.setUint8(25, 0xff);
  this._send_command(payload.buffer, function(err, data) {
    cb(err)
  })
}

exports.BakerMot = BakerMot
})(window.bm = {})
