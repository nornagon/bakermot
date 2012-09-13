function log(str) {
  document.querySelector('#output').appendChild(document.createElement('pre')).innerText = str
}

var bmo = new bm.BakerMot()
$ = function() { return document.querySelector.apply(document, arguments) }
$('#connect').onclick = function() {
  bmo.open(function(err) {
    if (err) {
      log('error connecting: '+err)
      throw err
    }
    bmo.get_version(function (err, version) {
      log("MakerBot firmware version "+version)
      bmo.get_name(function(err,name){
        log(name)
        connected()
      })
    })
  })
}

function command(name, fn) {
  var b = $('#controls').appendChild(document.createElement('button'))
  b.innerText = name
  b.id = name
  b.onclick = fn
}

command('abort', function() {
  bmo.abort(function(){})
})
command('home', function() {
  bmo.find_axes_maxima(1|2,500,60, function(err) {
    bmo.find_axes_minima(4,500,60, function(err) {
    })
  })
})
command('get pos', function() {
  bmo.get_position(function (err, p) {
    log('X:'+p.x + ' Y:'+p.y + ' Z:'+p.z)
  })
})
command('init', function() {
  bmo.init(function(){})
})
JOG_SPEED = 100000
command('x+', function() {
  bmo.queue_point(1000,0,0,0,0,JOG_SPEED, function(err) {
  })
})
command('x-', function() {
  bmo.queue_point(-1000,0,0,0,0,JOG_SPEED, function(err) {
  })
})
command('y+', function() {
  bmo.queue_point(0,1000,0,0,0,JOG_SPEED, function(err) {
  })
})
command('y-', function() {
  bmo.queue_point(0,-1000,0,0,0,JOG_SPEED, function(err) {
  })
})
command('z+', function() {
  bmo.queue_point(0,0,1000,0,0,JOG_SPEED, function(err) {
  })
})
command('z-', function() {
  bmo.queue_point(0,0,-1000,0,0,JOG_SPEED, function(err) {
  })
})

window.onkeydown = function(e) {
  if (e.keyCode == 37) // left
    document.getElementById('x-').onclick()
  else if (e.keyCode == 39) // right
    document.getElementById('x+').onclick()
  else if (e.keyCode == 38) // up
    document.getElementById('y+').onclick()
  else if (e.keyCode == 40) // up
    document.getElementById('y-').onclick()
  else if (e.keyCode == 34) // pgdn
    document.getElementById('z+').onclick()
  else if (e.keyCode == 33) // pgdn
    document.getElementById('z-').onclick()
}

function connected() {
  var bs = $('#controls').querySelectorAll('button')
  for (var i = 0; i < bs.length; i++) {
    bs[i].removeAttribute('disabled')
  }
  $('#connect').setAttribute('disabled', 'disabled')
}

function disconnected() {
  var bs = $('#controls').querySelectorAll('button')
  for (var i = 0; i < bs.length; i++) {
    bs[i].setAttribute('disabled', 'disabled')
  }
  $('#connect').removeAttribute('disabled')
}
disconnected()
