const WebSocketServer = require('websocket').server;
const https = require('https');
const fs = require('fs');
const net = require('net');
const buffer = require('buffer');
const request = require('request');

const config = JSON.parse(fs.readFileSync('/etc/webcaster-relay/config.json'));

let active_connections = [];

function init() {
    const server = https.createServer({
            key: fs.readFileSync(config.key),
            cert: fs.readFileSync(config.cert)
        }, function(request, response) {
            console.log((new Date()) + ' Received request for ' + request.url);
            response.writeHead(405);
            response.end();
    });
    server.listen(7443, function() {
        console.log((new Date()) + ' Server is listening on port 7443');
    });
     
    wsServer = new WebSocketServer({
        httpServer: server,
        autoAcceptConnections: false
    });

    wsServer.on('request', function(request) {

        const valid_request = rejectIfInvalid(request);

        if (valid_request) {
            session = new StreamingSession(request);
            session.accept();
        }
    });
}

function originIsAllowed(origin) {
  // put logic here to detect whether the specified origin is allowed.
  // true: Also known as "Yeah, sure, probably. Why not?"
  return true;
}

function rejectIfInvalid(request) {
    if (!originIsAllowed(request.origin)) {
        // Make sure we only accept requests from an allowed origin
        request.reject();
        console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
        return false;
    }
    
    if (request.requestedProtocols.indexOf('webcast') === -1) {
        request.reject(405, 'Unsupported subprotocol.');
        console.log((new Date()) + ' Connection for non-webcast subprotocol rejected.');
        return false;
    }

    if (active_connections.indexOf(request.resource) !== -1) {
        request.reject(429, 'Mount point already in use.');
        console.log((new Date()) + ' Connection rejected as mount point already connected.');
        return false;
    }

    return true;
}

class StreamingSession {
    constructor(request) {
        this.id = request.resource;
        this.request = request;
        this.authenticated = false;
        this.icecast_connection = null;
        this.ready = false;
        this.connection = null;
        this.client_alive = true;
    }

    log(message, extra) {
        if (extra) {
        console.log((new Date()) + ' ' + this.id + ': ' + message, extra);
        } else {
            console.log((new Date()) + ' ' + this.id + ': ' + message);
        }
    }

    accept() {
        this.connection = this.request.accept('webcast', this.request.origin);
        let me = this;
        this.connection.on('message', (message) => {me.onMessage(message)});
        this.connection.on('close', (reasonCode, description) => {me.onClose(reasonCode, description)});
    }

    onMessage(message) {
        if (message.type === 'utf8') {
            this.log('Received Message: ' + message.utf8Data);
            try {
                let metadata_message = JSON.parse(message.utf8Data);
                this.processMetadata(metadata_message);
            } catch (e) {
                this.log('That message isn\'t JSON.', e);
            }
        } else if (message.type === 'binary') {
            this.relayStreamBytes(message.binaryData)
        }
    }

    onClose(reasonCode, description) {
        this.log('WSS Connection closed');
        active_connections.splice(active_connections.indexOf(this.id), 1);
        if (this.icecast_connection && !this.icecast_connection.connecting && !this.icecast_connection.destroyed) {
            this.icecast_connection.end();
        }
        this.client_alive = false;
    }

    processMetadata(metadata) {
        if (metadata.type === "hello" && !this.authenticated) {
            let options = {
                method: 'POST',
                url: config.jarsJwtValidationUrl,
                headers: {
                    'User-Agent': 'webcaster-relay/1.0.0'
                },
                form: {
                    auth: metadata.data.password,
                    mount: session.id.replace('/', '')
                }
            }

            let me = this;

            request(options, (error, response, body) => {
                if (response && response.statusCode === 202) {
                    // Yay!
                    this.log('Authentication successful');
                    this.authenticated = true;
                    active_connections.push(session.id);
                    this.connectToIcecast();
                } else {
                    // Aww :(
                    this.log('Authentication failed (1)', error);
                    this.log('Authentication failed (2)', response);
                    this.log('Authentication failed (3)', body);
                    this.connection.close(1008, "Invalid authentication data.");
                }
            });
        }
    }

    relayStreamBytes(bytes) {
        if (this.ready) {
            this.icecast_connection.write(bytes);
        } else {
            this.log('Not relaying bytes, not yet ready.');
        }
    }

    connectToIcecast() {
        this.icecast_connection = new net.Socket();

        let authorisation = Buffer.from(config.icyUser + ':' + config.icyPass, 'ascii').toString('base64');
        let c = this.icecast_connection;
        let stream = this;
        let closed_during_setup = false;

        function write(str, cb) {
            if (!c.destroyed) {
                console.log(str);
                c.write(str + "\n", cb);
            } else {
                this.log('Connection destroyed during setup?');
            }
        }

        this.icecast_connection.setEncoding('ascii');

        this.icecast_connection.on('data', (data) => {
            stream.log('Icecast data received', data.replace("\n", '').replace("\r", ''));
            if (data.indexOf('HTTP/1.1 100 Continue') !== -1) {
                stream.log('Ready to send data.');
                stream.ready = true;
            }
        });
        this.icecast_connection.on('close', (had_error) => {
            stream.log('Icecast connection closed', had_error);
            stream.ready = false;
            if (this.client_alive) {
                setTimeout(() => stream.connectToIcecast.call(stream), 500);
            }
        });
        this.icecast_connection.on('error', (error) => {
            stream.log('Icecast connection error', error);
            stream.ready = false;
            if (this.client_alive) {
                setTimeout(() => stream.connectToIcecast.call(stream), 500);
            }
        })

        this.icecast_connection.connect({
            host: config.icyHost,
            port: config.icyPort
        }, function() {
            write("PUT " + stream.id + " HTTP/1.1");
            write("Host: " + config.icyHost + ":" + config.icyPort);
            write("Authorization: Basic " + authorisation);
            write("User-Agent: webcaster-relay/1.0.0");
            write("Transfer-Encoding: chunked");
            write("Content-Type: audio/mpeg");
            write("Ice-Public: 1"); // TODO: Populate from jars
            write("Ice-Name: Beep Boop"); // TODO: Populate from jars (or hello?)
            write("Expect: 100-continue");
            write("");
        });
    }
}
 
init();
