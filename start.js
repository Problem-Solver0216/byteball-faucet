/*jslint node: true */
"use strict";
var conf = require('byteballcore/conf.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var mail = require('byteballcore/mail.js');
var headlessWallet = require('headless-byteball');
var desktopApp = require('byteballcore/desktop_app.js');
var ValidationUtils = require("byteballcore/validation_utils.js");

const GREETING_TIMEOUT = 300*1000;
const SESSION_TIMEOUT = 600*1000;
var assocSessions = {};

function notifyAdmin(subject, body){
	mail.sendmail({
		to: conf.admin_email,
		from: conf.from_email,
		subject: subject,
		body: body
	});
}

function notifyAdminAboutFailedPayment(err){
	console.log('payment failed: '+err);
	notifyAdmin('payment failed: '+err, err);
}

function getRandomInt(min, max) {
	return Math.floor(Math.random() * (max+1 - min)) + min;
}

function resumeSession(device_address){
	if (!assocSessions[device_address])
		assocSessions[device_address] = {};
	assocSessions[device_address].ts = Date.now();
}

function purgeOldSessions(){
	console.log('purging old sessions');
	var cutoff_ts = Date.now() - SESSION_TIMEOUT;
	for (var device_address in assocSessions)
		if (assocSessions[device_address].ts < cutoff_ts)
			delete assocSessions[device_address];
}
setInterval(purgeOldSessions, SESSION_TIMEOUT);

function sendMessageToDevice(device_address, text){
	var device = require('byteballcore/device.js');
	device.sendMessageToDevice(device_address, 'text', text);
//	assocSessions[device_address].ts = Date.now();
}

function sendGreeting(device_address){
	sendMessageToDevice(device_address, 'To receive free bytes, let me know your Byteball address (use "Insert My Address" button)');
	assocSessions[device_address].greeting_ts = Date.now();
}

function sendUnrecognizedCommand(device_address){
	sendMessageToDevice(device_address, 'Unrecognized command');
}

function sendUnrecognizedCommandOrGreeting(device_address){
	(assocSessions[device_address].greeting_ts && assocSessions[device_address].greeting_ts > Date.now() - GREETING_TIMEOUT)
		? sendUnrecognizedCommand(device_address)
		: sendGreeting(device_address);
}

eventBus.on('headless_wallet_ready', function(){
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
});

eventBus.on('paired', function(from_address){
	console.log('paired '+from_address);
	if (headlessWallet.isControlAddress(from_address))
		headlessWallet.handlePairing(from_address);
	resumeSession(from_address);
	sendGreeting(from_address);
});

eventBus.on('text', function(from_address, text){
	console.log('text from '+from_address+': '+text);
	if (headlessWallet.isControlAddress(from_address))
		headlessWallet.handleText(from_address, text);
	resumeSession(from_address);
	text = text.trim();
	var arrMatches = text.match(/\b[A-Z2-7]{32}\b/);
	if (!arrMatches)
		return sendUnrecognizedCommandOrGreeting(from_address);
	var address = arrMatches[0];
	if (!ValidationUtils.isValidAddress(address))
		return sendMessageToDevice(from_address, 'Please send a valid address');
	db.query(
		"SELECT amount FROM faucet_payouts WHERE device_address=? AND creation_date > "+db.addTime("-1 DAY")+" LIMIT 1", 
		[from_address], 
		function(rows){
			if (rows.length > 0)
				return sendMessageToDevice(from_address, "You can request free bytes only once per 24 hours.  I've already sent you "+rows[0].amount+" bytes");
			var amount = getRandomInt(conf.MIN_AMOUNT_IN_KB, conf.MAX_AMOUNT_IN_KB) * 1000;
			headlessWallet.issueChangeAddressAndSendPayment(amount, address, from_address, function(err){
				if (err)
					return notifyAdminAboutFailedPayment(err);
				db.query("INSERT INTO faucet_payouts (device_address, amount, address) VALUES(?,?,?)", [from_address, amount, address], function(){});
			});
		}
	);
});