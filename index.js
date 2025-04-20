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

// Throttled Queue Implementation
class ThrottledQueue {
    constructor(processFn, intervalMs, name = 'Queue') {
        if (typeof processFn !== 'function') {
            throw new Error(`processFn for ${name} must be a function`);
        }
        if (typeof intervalMs !== 'number' || intervalMs <= 0) {
            throw new Error(`intervalMs for ${name} must be a positive number`);
        }
        this._processFn = processFn;
        this._intervalMs = intervalMs;
        this._queue = [];
        this._interval = null;
        this._name = name; // For logging/debugging
    }

    add(item) {
        this._queue.push(item);
        // Start processing if not already running
        if (this._interval === null) {
            // Start the interval timer
            this._interval = setInterval(() => this._process(), this._intervalMs);
            // Process the first item immediately
            this._process();
        }
    }

    _process() {
        if (this._queue.length === 0) {
            // Stop the interval if queue is empty
            if (this._interval !== null) {
                clearInterval(this._interval);
                this._interval = null;
            }
        } else {
            // Dequeue and process the next item
            const item = this._queue.shift();
            try {
                 this._processFn(item);
            } catch (error) {
                 console.error(`Error processing ${this._name} item:`, error, "Item:", item);
                 // Optional: Add logic here to requeue or handle specific errors
            }
        }
    }

    get length() {
      return this._queue.length;
    }

    isEmpty() {
      return this._queue.length === 0;
    }

    // Optional: Method to clear the queue if needed
    clear() {
        this._queue = [];
        if (this._interval !== null) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }
}

// Instantiate queues
const mqttPublishQueue = new ThrottledQueue(
    (msg) => {
        if (client.connected) { // Check connection before publishing
            client.publish(msg.topic, msg.payload, msg.options);
        } else {
            console.warn("MQTT client not connected. Dropping message:", msg);
            // Optional: Implement retry or persistent queue logic here
        }
    },
    messageinterval,
    'MQTT Publish'
);

const cgateCommandQueue = new ThrottledQueue(
    (commandString) => {
        if (commandConnected) { // Check connection before writing
             command.write(commandString);
        } else {
             console.warn("C-Gate command socket not connected. Dropping command:", commandString);
             // Optional: Implement retry logic
        }
    },
    messageinterval, // Use same interval for commands for now
    'C-Gate Command'
);

var CBusEvent = function(data){
  // "lighting on 254/56/4  #sourceunit=8 OID=3ff2ab90-c9b1-1039-b7d7-fb32921605ee sessionId=cmd1 commandId={none}"
  var parts = data.toString().split("  ")[0].split(" ");

  // extract the device type
  this.DeviceType = function(){ return parts[0].toString(); };

  // action type
  this.Action = function(){ return parts[1]; }

  // pull apart the address HOST/GROUP/DEVICEID
  var address = (parts[2].substring(0,parts[2].length)).split("/");
  
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

var CBusCommand = function(topic, message){
  // "cbus/write/254/56/7/switch ON"
  var parts = topic.toString().split("/");
  if (parts.length < 6 ) return;

  // pull apart the address HOST/GROUP/DEVICEID
  this.Host = function(){ return parts[2].toString(); }
  this.Group = function(){ return parts[3].toString(); }
  this.Device = function(){ return parts[4].toString(); }

  // command type
  var commandParts = parts[5].split(' ');
  this.CommandType = function(){ return commandParts[0]; }

  // action type
  this.Action = function(){ return commandParts[0]; }

  // pull out message
  this.Message = function(){ return message.toString(); }

  // pull out level
  var _this = this;
  this.Level = function(){ 
    // if set to "on" then this is 100
    if (_this.Action() == "on"){
      return "100";
    }

    // pull out ramp value
    var messageParts = _this.Message().split(' ');
    if (messageParts.length > 1){
      return Math.round(parseInt(messageParts[1])*100/255).toString();
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
      cgateCommandQueue.add('GET //'+settings.cbusname+'/'+settings.getallnetapp+'/* level\n');
    }
    if(settings.getallnetapp && settings.getallperiod) {
      clearInterval(interval);
      setInterval(function(){
        console.log('Getting all values');
        cgateCommandQueue.add('GET //'+settings.cbusname+'/'+settings.getallnetapp+'/* level\n');
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
      log('MQTT received on ' + topic + ' : ' + message);
      
      //Example format "cbus/write/254/56/118/switch ON"
      parts = topic.split("/");
      if (parts.length > 5) {
      
      var command = new CBusCommand(topic, message);
      switch(command.CommandType()) {

        // Get updates from all groups
        case "gettree":
          treenet = parts[2];
          cgateCommandQueue.add('TREEXML '+command.Host()+'\n');
          break;


        // Get updates from all groups
        case "getall":
          cgateCommandQueue.add('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/* level\n');
          break;

        // On/Off control
        case "switch":
          var messageParts = message.split(' ');
          if(messageParts[0] == "ON") { cgateCommandQueue.add('ON //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n')};
          if(messageParts[0] == "OFF") { cgateCommandQueue.add('OFF //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n')};
          break;

        // Ramp, increase/decrease, on/off control
        case "ramp":
          switch(message.toUpperCase()) {
            case "INCREASE":
              eventEmitter.on('level',function increaseLevel(address,level) {
                if (address == command.Host()+'/'+command.Group()+'/'+command.Device()) {
                  cgateCommandQueue.add('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+Math.min((level+26),255)+' '+'\n');
                  eventEmitter.removeListener('level',increaseLevel);
                }
              });
              cgateCommandQueue.add('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' level\n');

              break;

            case "DECREASE":
              eventEmitter.on('level',function decreaseLevel(address,level) {
                if (address == command.Host()+'/'+command.Group()+'/'+command.Device()) {
                  cgateCommandQueue.add('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+Math.max((level-26),0)+' '+'\n');
                  eventEmitter.removeListener('level',decreaseLevel);
                }
              });
              cgateCommandQueue.add('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' level\n');

              break;

            case "ON":
              cgateCommandQueue.add('ON //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');
              break;
            case "OFF":
              cgateCommandQueue.add('OFF //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');
              break;
            default:
              var ramp = message.split(",");
              var num = Math.round(parseInt(ramp[0])*255/100)
              if (!isNaN(num) && num < 256) {

                if (ramp.length > 1) {
                  cgateCommandQueue.add('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+num+' '+ramp[1]+'\n');
                } else {
                  cgateCommandQueue.add('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+num+'\n');
                }
              }
          }
          break;
        default:
          log('Unknown command type received: ' + command.CommandType());
        }
      } else {
        log('Ignoring MQTT message on topic ' + topic + ' - insufficient parts.');
      }
    });
  });

  // publish a message to a topic
  mqttPublishQueue.add({topic:'hello/world', payload:'CBUS ON'});
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
  cgateCommandQueue.add('EVENT ON\n');
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
  var lines = (buffer+data.toString()).split("\n");
  buffer = lines[lines.length-1];
  if (lines.length > 1) {
    for (i = 0;i<lines.length-1;i++) {
      var parts1 = lines[i].toString().split("-");
      if(parts1.length > 1 && parts1[0] == "300") {
        var parts2 = parts1[1].toString().split(" ");

        // Parse input data
        var action = new CBusEvent(parts2[0]);

        if (action.Level() == 0) {
          log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' OFF');
          log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' 0%');
          mqttPublishQueue.add({topic: 'cbus/read/'+action.Host() +'/'+action.Group()+'/'+action.Device()+'/state' , payload: 'OFF', options: options});
          mqttPublishQueue.add({topic: 'cbus/read/'+action.Host() +'/'+action.Group()+'/'+action.Device()+'/level' , payload: '0', options: options});
          eventEmitter.emit('level',action.Host() +'/'+action.Group()+'/'+action.Device(),0);
        } else {
          log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' ON');
          log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' '+action.Level()+'%');
          mqttPublishQueue.add({topic: 'cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , payload: 'ON', options: options});
          mqttPublishQueue.add({topic: 'cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , payload: action.Level(), options: options});
          eventEmitter.emit('level',action.Host() +'/'+action.Group()+'/'+action.Device(),action.Level());
        }
      } else if(parts1[0] == "347"){
        tree += parts1[1]+'\n';
      } else if(parts1[0] == "343"){
        tree = '';
      } else if(parts1[0].split(" ")[0] == "344"){
        parseString(tree, function (err, result) {
          try{
            log("C-Bus tree received:"+JSON.stringify(result));
            mqttPublishQueue.add({topic: 'cbus/read/'+treenet+'///tree', payload: JSON.stringify(result)});
          }catch(err){
            console.log(err)
          }
          tree = '';
        });
      } else {
        var parts2 = parts1[0].toString().split(" ");
        if (parts2[0] == "300") {
          // Parse input data
          var action = new CBusEvent(parts2[1]);

          var level = parts2[2].split("=");
          var levelValue = parseInt(level[1]);
          var levelPercent = Math.round(levelValue * 100 / 255).toString();

          if (levelValue === 0) {
            log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' OFF');
            log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' 0%');
            mqttPublishQueue.add({topic:'cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , payload: 'OFF', options: options});
            mqttPublishQueue.add({topic:'cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , payload: '0', options: options});
            eventEmitter.emit('level',action.Host()+'/'+action.Group()+'/'+action.Device(),0);
          } else {
            log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' ON');
            log('C-Bus command received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' '+ levelPercent +'%');
            mqttPublishQueue.add({topic:'cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , payload: 'ON', options: options});
            mqttPublishQueue.add({topic:'cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , payload: levelPercent, options: options});
            eventEmitter.emit('level',action.Host()+'/'+action.Group()+'/'+action.Device(), levelValue);

          }

        } else {
            // Log unhandled lines from command port if needed
             log('Unhandled command port line part: ' + parts1[0]);
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
        mqttPublishQueue.add({topic: 'cbus/read/' + action.Host() + '/' + action.Group() + '/' + action.Device() + '/state' , payload: 'ON', options: options});
        mqttPublishQueue.add({topic: 'cbus/read/' + action.Host() + '/' + action.Group() + '/' + action.Device() + '/level' , payload: '100', options: options});
        break;
      case "off":
        log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' OFF');
        log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' 0%');
        mqttPublishQueue.add({topic: 'cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/state' , payload: 'OFF', options: options});
        mqttPublishQueue.add({topic: 'cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/level' , payload: '0', options: options});
        break;
      case "ramp":
        var levelPercent = action.Level();
        if(levelPercent > 0) {
          log('C-Bus status received: '+ action.Host() +'/'+ action.Group() + '/' + action.Device() + ' ON');
          log('C-Bus status received: '+ action.Host() +'/'+ action.Group() + '/' + action.Device() + ' ' + levelPercent + '%');
          mqttPublishQueue.add({topic: 'cbus/read/'+ action.Host() +'/'+ action.Group() + '/' + action.Device() + '/state', payload: 'ON', options: options});
          mqttPublishQueue.add({topic: 'cbus/read/'+ action.Host() +'/'+ action.Group() + '/' + action.Device() + '/level', payload: levelPercent, options: options});
        } else {
          log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' OFF');
          log('C-Bus status received: '+ action.Host() + '/' + action.Group() + '/' + action.Device() + ' 0%');
          mqttPublishQueue.add({topic: 'cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/state', payload: 'OFF', options: options});
          mqttPublishQueue.add({topic: 'cbus/read/'+ action.Host() + '/' + action.Group() + '/' + action.Device() + '/level', payload: '0', options: options});
        }
        break;
      default:
         log('Unknown lighting action from event port: ' + action.Action());
    }

  } else {
      log('Unhandled event type from event port: ' + action.DeviceType());
  }
  
});

