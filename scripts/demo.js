'use strict';
// npm run demo  - creates a LOCAL demo account + sample data so you can try the dashboard immediately.
// Safety: never a fixed password (a fresh random one is printed once), only on a fresh database,
// refuses when SENDERBOLT_SENDING=live or the server is not bound to localhost, and the sample
// leads use reserved ".example" domains. Re-run with --reset-password to get a new demo password.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var config = require('../src/config');
var database = require('../src/db');
var migrate = require('../src/db/migrate').migrate;
var password = require('../src/lib/password');
var Sessions = require('../src/services/sessions').Sessions;
var Auth = require('../src/services/auth').Auth;
var Senders = require('../src/services/senders').Senders;
var Leads = require('../src/services/leads').Leads;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var ProjectsService = require('../src/services/projects').ProjectsService;

var EMAIL = 'demo@example.com';

function die(msg) { console.error('\n' + msg + '\n'); process.exit(1); }
function strongPassword() { return crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, 'x'); }

config.loadEnvFile(path.join(process.cwd(), '.env'));
var cfg;
try { cfg = config.build(process.env); } catch (e) { die('Configuration error: ' + e.message + '\nRun "npm run init" first.'); }
if (cfg.sending === 'live') die('Refusing: SENDERBOLT_SENDING=live. Demo data must never be used with real sending. Set it to dry-run.');
if (['127.0.0.1', 'localhost', '::1'].indexOf(cfg.host) === -1) die('Refusing: HOST is ' + cfg.host + '. The demo account is only for a server bound to localhost.');

if (cfg.dbFile !== ':memory:') fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
var reset = process.argv.indexOf('--reset-password') !== -1;

database.open(cfg.dbFile, { driver: cfg.dbDriver }).then(function (db) {
  return migrate(db).then(function () { return db.all('SELECT id, email FROM users'); }).then(function (users) {
    var demo = users.filter(function (u) { return u.email === EMAIL; })[0];
    if (demo) {
      if (!reset) die('Demo data is already there. To get a new demo password run: npm run demo -- --reset-password');
      var pw = strongPassword();
      return password.hashAsync(pw).then(function (hash) {
        return db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [hash, demo.id])
          .then(function () { return db.run('DELETE FROM sessions WHERE user_id = ?', [demo.id]); }).then(function () { return pw; });
      }).then(function (p) { return { pw: p, db: db, seeded: false }; });
    }
    if (users.length) die('Refusing: this database already has your real account. Demo data is only added to a fresh database (delete the data folder to start over).');
    var pw2 = strongPassword();
    var sessions = new Sessions(db, { secret: cfg.sessionSecret }), auth = new Auth(db, sessions, {});
    var senders = new Senders(db, cfg.masterKey), leads = new Leads(db, {}), camps = new CampaignsService(db), projects = new ProjectsService(db, { campaigns: camps });
    var uid, sids = [];
    return auth.createUser(EMAIL, pw2, 'demo').then(function () { return db.get('SELECT id FROM users WHERE email = ?', [EMAIL]); }).then(function (u) {
      uid = u.id;
      function sender(n) {
        return senders.create(uid, { label: 'Demo Gmail ' + n, email: 'demo.sender' + n + '@gmail.com', provider: 'gmail', password: 'abcd efgh ijkl mnop', daily_limit: 100, warmup_enabled: 0,
          delay_mode: 'random', delay_min_sec: 5, delay_max_sec: 12 }).then(function (s) { sids.push(s.id); });
      }
      return sender(1).then(function () { return sender(2); });
    }).then(function () { return leads.createFolder(uid, 'Demo leads'); }).then(function (f) {
      var emails = [], i;
      for (i = 1; i <= 40; i++) emails.push('contact' + i + '@demo-company-' + i + '.example');
      return leads.importLeads(uid, f.id, 'paste', emails.join('\n')).then(function () {
        return projects.create(uid, { name: 'Demo: domain outreach', description: 'Sample project with two email versions to compare.' });
      }).then(function (pj) {
        function steps(pitch) { return [{ subject: 'Question about {{company|your domain}}', body_html: '<p>Hi {{first_name|there}},</p><p>' + pitch + '</p>' }, { subject: '', delay_days: 3, body_html: '<p>Just following up in case this got buried.</p>' }]; }
        var common = { sender_ids: sids, project_id: pj.id, window_start_hour: 0, window_end_hour: 24, weekdays_only: 0 };
        return db.all('SELECT id FROM leads WHERE user_id = ? ORDER BY id', [uid]).then(function (rows) {
          var ids = rows.map(function (r) { return r.id; });
          return camps.create(uid, Object.assign({ name: 'Version A - short pitch', steps: steps('Are you open to offers on this name?'), lead_ids: ids.slice(0, 20) }, common))
            .then(function (a) { return camps.create(uid, Object.assign({ name: 'Version B - detailed pitch', steps: steps('I represent a buyer interested in your domain and can share a number.'), lead_ids: ids.slice(20) }, common)).then(function () { return a; }); });
        }).then(function (a) { return camps.start(uid, a.id); });
      });
    }).then(function () { return { pw: pw2, db: db, seeded: true }; });
  });
}).then(function (r) {
  console.log('\n' + (r.seeded ? 'Demo data created.' : 'Demo password reset.'));
  console.log('\n  Sign in at http://' + cfg.host + ':' + cfg.port + '\n  Email:    ' + EMAIL + '\n  Password: ' + r.pw + '\n');
  console.log('This password is shown only now. Start the server with: npm start  (it runs in test mode: nothing real is sent).\n');
  return r.db.close();
}).catch(function (e) { die('Demo setup failed: ' + e.message); });
