#!/usr/bin/env node
var mqtt = require('mqtt'), url = require('url');
var net = require('net');
var events = require('events');
var settings = require('./settings.js');
var parseString = require('xml2js').parseString;

var options = {};
if(settings.retainreads === true) {
    options.retain = true;
}

var tree = '';
var treenet = 0;

var interval = {};
var commandInterval = {};
var eventInterval = {};
var clientConnected = false;
var commandConnected = false;
var eventConnected = false;
var buffer = "";
var eventEmitter = new events.EventEmitter();
var messageinterval = settings.messageinterval || 200;

// MQTT URL
var mqtt_url = url.parse('mqtt://'+settings.mqtt);

// Username and password
var OPTIONS = {};
if(settings.mqttusername && settings.mqttpassword) {
  OPTIONS.username = settings.mqttusername;
  OPTIONS.password = settings.mqttpassword;
}

// Create an MQTT client connection
var client = mqtt.createClient(mqtt_url.port, mqtt_url.hostname,OPTIONS);
var command = new net.Socket();
var event = new net.Socket();

var queue =  {
  publish: function (topic, payload ) {
    queue.queue.push({topic:topic,payload:payload})
    if(queue.interval === null) {
      queue.interval = setInterval(queue.process,messageinterval)
      queue.process()
    }
  },
  process: function() {
    if(queue.queue.length === 0) {
      clearInterval(queue.interval)
      queue.interval = null
    } else {
      var msg = queue.queue.shift()
      client.publish(msg.topic,msg.payload)
    }
  },
  interval: null,
  queue:[]
}

var queue2 =  {
  write: function (value) {
    queue2.queue.push(value)
    if(queue2.interval === null) {
      queue2.interval = setInterval(queue2.process,messageinterval)
      queue2.process()
    }
  },
  process: function() {
    if(queue2.queue.length === 0) {
      clearInterval(queue2.interval)
      queue2.interval = null
    } else {
      command.write(queue2.queue.shift())
    }
  },
  interval: null,
  queue:[]
}

var CBusEvent = function(data){
  // "lighting on 254/56/4  #sourceunit=8 OID=3ff2ab90-c9b1-1039-b7d7-fb32921605ee sessionId=cmd1 commandId={none}"
  var parts = data.toString().split(" ");

  // extract the device type
  this.DeviceType = function(){ return parts[0].toString(); };

  // action type
  this.Action = function(){ return parts[1]; }

  // pull apart the address HOST/GROUP/DEVICEID
  var address = (parts[2].substring(0,parts[2].length-1)).split("/");
  
  this.Host = function(){ return address[0].toString(); }
  this.Group = function(){ return address[1].toString(); }
  this.Device = function(){ return address[2].toString(); }

  // pull out level
  var _this = this;
  this.Level = function(){ 
    // if set to "on" then this is 100
    if (_this.Action() == "on"){
      return "100";
    }

    // pull out ramp value
    if (parts.length > 3){
      return Math.round(parseInt(parts[3])*100/255).toString();
    }

    if (_this.Action() == "off"){
      return "0";
    }
  }
}


var HOST = settings.cbusip;
var COMPORT = 20023;
var EVENTPORT = 20025;

var logging = settings.logging;
var log = function(msg){if (logging==true) {console.log(msg);}}

// Connect to cgate via telnet
command.connect(COMPORT, HOST);


// Connect to cgate event port via telnet
event.connect(EVENTPORT, HOST);

function started(){
  if(commandConnected && eventConnected && client.connected){
    console.log('ALL CONNECTED');
    if(settings.getallnetapp && settings.getallonstart) {
      console.log('Getting all values');
      queue2.write('GET //'+settings.cbusname+'/'+settings.getallnetapp+'/* level\n');
    }
    if(settings.getallnetapp && settings.getallperiod) {
      clearInterval(interval);
      setInterval(function(){
        console.log('Getting all values');
        queue2.write('GET //'+settings.cbusname+'/'+settings.getallnetapp+'/* level\n');
      },settings.getallperiod*1000);
    }
  }

}

client.on('disconnect',function(){
  clientConnected = false;
})

client.on('connect', function() { // When connected
  clientConnected = true;
  console.log('CONNECTED TO MQTT: ' + settings.mqtt);
  started()

  // Subscribe to MQTT
  client.subscribe('cbus/write/#', function() {

    // when a message arrives, do something with it
    client.on('message', function(topic, message, packet) {
      if (logging == true) {console.log('Message received on ' + topic + ' : ' + message);}

      parts = topic.split("/");
      if (parts.length > 5)

      switch(parts[5].toLowerCase()) {

        // Get updates from all groups
        case "gettree":
          treenet = parts[2];
          queue2.write('TREEXML '+parts[2]+'\n');
          break;


        // Get updates from all groups
        case "getall":
          queue2.write('GET //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/* level\n');
          break;

        // On/Off control
        case "switch":

          if(message == "ON") {queue2.write('ON //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+'\n')};
          if(message == "OFF") {queue2.write('OFF //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+'\n')};
          break;

        // Ramp, increase/decrease, on/off control
        case "ramp":
          switch(message.toUpperCase()) {
            case "INCREASE":
              eventEmitter.on('level',function increaseLevel(address,level) {
                if (address == parts[2]+'/'+parts[3]+'/'+parts[4]) {
                  queue2.write('RAMP //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+' '+Math.min((level+26),255)+' '+'\n');
                  eventEmitter.removeListener('level',increaseLevel);
                }
              });
              queue2.write('GET //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+' level\n');

              break;

            case "DECREASE":
              eventEmitter.on('level',function decreaseLevel(address,level) {
                if (address == parts[2]+'/'+parts[3]+'/'+parts[4]) {
                  queue2.write('RAMP //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+' '+Math.max((level-26),0)+' '+'\n');
                  eventEmitter.removeListener('level',decreaseLevel);
                }
              });
              queue2.write('GET //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+' level\n');

              break;

            case "ON":
              queue2.write('ON //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+'\n');
              break;
            case "OFF":
              queue2.write('OFF //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+'\n');
              break;
            default:
              var ramp = message.split(",");
              var num = Math.round(parseInt(ramp[0])*255/100)
              if (!isNaN(num) && num < 256) {

                if (ramp.length > 1) {
                  queue2.write('RAMP //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+' '+num+' '+ramp[1]+'\n');
                } else {
                  queue2.write('RAMP //'+settings.cbusname+'/'+parts[2]+'/'+parts[3]+'/'+parts[4]+' '+num+'\n');
                }
              }
          }
          break;
        default:
      }
    });
  });

  // publish a message to a topic
  queue.publish('hello/world', 'CBUS ON', function() {
  });
});

command.on('error',function(err){
  console.log('COMMAND ERROR:'+JSON.stringify(err))
})

event.on('error',function(err){
  console.log('EVENT ERROR:'+JSON.stringify(err))
})

command.on('connect',function(err){
  commandConnected = true;
  console.log('CONNECTED TO C-GATE COMMAND PORT: ' + HOST + ':' + COMPORT);
  queue2.write('EVENT ON\n');
  started()
  clearInterval(commandInterval);
})

event.on('connect',function(err){
  eventConnected = true;
  console.log('CONNECTED TO C-GATE EVENT PORT: ' + HOST + ':' + EVENTPORT);
  started()
  clearInterval(eventInterval);
})


command.on('close',function(){
  commandConnected = false;
  console.log('COMMAND PORT DISCONNECTED')
  commandInterval = setTimeout(function(){
    console.log('COMMAND PORT RECONNECTING...')
    command.connect(COMPORT, HOST)
  },10000)
})

event.on('close',function(){
  eventConnected = false;
  console.log('EVENT PORT DISCONNECTED')
  eventInterval = setTimeout(function(){
    console.log('EVENT PORT RECONNECTING...')
    event.connect(EVENTPORT, HOST)
  },10000)
})

command.on('data',function(data) {
  // if (logging == true) {console.log('Command data: ' + data);}
  var lines = (buffer+data.toString()).split("\n");
  buffer = lines[lines.length-1];
  if (lines.length > 1) {
    for (i = 0;i<lines.length-1;i++) {
      var parts1 = lines[i].toString().split("-");
      if(parts1.length > 1 && parts1[0] == "300") {
        var parts2 = parts1[1].toString().split(" ");

        address = (parts2[0].substring(0,parts2[0].length-1)).split("/");
        var level = parts2[1].split("=");
        if (parseInt(level[1]) == 0) {
          log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' OFF');
          log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' 0%');
          queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/state' , 'OFF',options, function() {});
          queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/level' , '0',options, function() {});
          eventEmitter.emit('level',address[3]+'/'+address[4]+'/'+address[5],0);
        } else {
          log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' ON');
          log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' '+Math.round(parseInt(level[1])*100/255).toString()+'%');
          queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/state' , 'ON',options, function() {});
          queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/level' , Math.round(parseInt(level[1])*100/255).toString(),options, function() {});
          eventEmitter.emit('level',address[3]+'/'+address[4]+'/'+address[5],Math.round(parseInt(level[1])));

        }
      } else if(parts1[0] == "347"){
        tree += parts1[1]+'\n';
      } else if(parts1[0] == "343"){
        tree = '';
      } else if(parts1[0].split(" ")[0] == "344"){
        parseString(tree, function (err, result) {
          try{
            log("C-Bus tree received:"+JSON.stringify(result));
            queue.publish('cbus/read/'+treenet+'///tree',JSON.stringify(result))
          }catch(err){
            console.log(err)
          }
          tree = '';
        });
      } else {
        var parts2 = parts1[0].toString().split(" ");
        if (parts2[0] == "300") {
          address = (parts2[1].substring(0,parts2[1].length-1)).split("/");
          var level = parts2[2].split("=");
          if (parseInt(level[1]) == 0) {
            log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' OFF');
            log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' 0%');
            queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/state' , 'OFF',options, function() {});
            queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/level' , '0',options, function() {});
            eventEmitter.emit('level',address[3]+'/'+address[4]+'/'+address[5],0);
          } else {
            log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' ON');
            log('C-Bus command received: '+address[3] +'/'+address[4]+'/'+address[5]+' '+Math.round(parseInt(level[1])*100/255).toString()+'%');
            queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/state' , 'ON',options, function() {});
            queue.publish('cbus/read/'+address[3]+'/'+address[4]+'/'+address[5]+'/level' , Math.round(parseInt(level[1])*100/255).toString(),options, function() {});
            eventEmitter.emit('level',address[3]+'/'+address[4]+'/'+address[5],Math.round(parseInt(level[1])));

          }

        }
      }
    }
  }
});

// Add a 'data' event handler for the client socket
// data is what the server sent to this socket
event.on('data', function(data) {
  // handle comments in the data stream. ignore
  if (data.toString()[0]=="#") {
    return;
  }
  // Parse input data
  var action = new CBusEvent(data);

  if(action.DeviceType() == "lighting") {

    switch(action.Action()) {
      case "on":
        log('C-Bus status received: ' + action.Host() + '/' + action.Group() + '/' + action.Device() + ' ON');
        log('C-Bus status received: ' + action.Host() + '/' + action.Group() + '/' + action.Device() + ' 100%');
        queue.publish('cbus/read/' + action.Host() + '/' + action.Group() + '/' + action.Device() + '/state' , 'ON', options, function() {});
        queue.publish('cbus/read/' + action.Host() + '/' + action.Group() + '/' + action.Device() + '/level' , '100', options, function() {});
        break;
      case "off":
        log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' OFF');
        log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' 0%');
        queue.publish('cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/state' , 'OFF', options, function() {});
        queue.publish('cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/level' , '0', options, function() {});
        break;
      case "ramp":
        if(action.Level() > 0) {
          log('C-Bus status received: '+ action.Host() +'/'+ action.Group() + '/' + action.Device() + ' ON');
          log('C-Bus status received: '+ action.Host() +'/'+ action.Group() + '/' + action.Device() + ' ' + action.Level() + '%');
          queue.publish('cbus/read/'+ action.Host() +'/'+ action.Group() + '/' + action.Device() + '/state', 'ON', options, function() {});
          queue.publish('cbus/read/'+ action.Host() +'/'+ action.Group() + '/' + action.Device() + '/level', action.Level(), options, function() {});
        } else {
          log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' OFF');
          log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' 0%');
          queue.publish('cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/state', 'OFF', options, function() {});
          queue.publish('cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/level', '0', options, function() {});
        }
        break;
      default:
    }

  }
  
});

