'use strict';
var assert = require('assert');
var h = require('./helpers');
var Leads = require('../src/services/leads').Leads;
var parseInput = require('../src/services/leads').parseInput;

function err(code) { var e = new Error(code); e.code = code; return e; }
// Fake DNS: domain -> behaviour
var DNS = {
  'good.com': { mx: [{ exchange: 'mx.good.com', priority: 10 }] },
  'nullmx.com': { mx: [{ exchange: '', priority: 0 }] },
  'nxdomain.com': { mxErr: 'ENOTFOUND' },
  'nomx-a.com': { mxErr: 'ENODATA', a: ['1.2.3.4'] },
  'nomx-none.com': { mxErr: 'ENODATA', aErr: 'ENODATA' },
  'flaky.com': { mxErr: 'ETIMEOUT' }
};
var lookups = {};
var resolver = {
  resolveMx: function (d) {
    lookups[d] = (lookups[d] || 0) + 1;
    var r = DNS[d]; if (!r) return Promise.reject(err('ENOTFOUND'));
    return r.mxErr ? Promise.reject(err(r.mxErr)) : Promise.resolve(r.mx);
  },
  resolveAddr: function (d) { var r = DNS[d]; return r.aErr ? Promise.reject(err(r.aErr)) : Promise.resolve(r.a || []); }
};

function setup() {
  return h.freshDb().then(function (db) {
    return h.mkUser(db, 'a@x.com').then(function (a) {
      return h.mkUser(db, 'b@x.com').then(function (b) {
        var svc = new Leads(db, { resolver: resolver });
        return svc.createFolder(a, 'Domains').then(function (f) { return { db: db, svc: svc, a: a, b: b, folder: f.id }; });
      });
    });
  });
}

h.group('leads: folders and import');
h.test('folder create, duplicate (case-insensitive), rename, scoping, delete', function () {
  return setup().then(function (c) {
    return h.expectReject(c.svc.createFolder(c.a, 'domains'), 'validation')
      .then(function () { return h.expectReject(c.svc.createFolder(c.a, '   '), 'validation'); })
      .then(function () { return c.svc.renameFolder(c.a, c.folder, 'Domain buyers'); })
      .then(function () { return h.expectReject(c.svc.renameFolder(c.b, c.folder, 'hax'), 'not_found'); })
      .then(function () { return c.svc.createFolder(c.b, 'Domain buyers'); })           // same name, other user: fine
      .then(function () { return c.svc.listFolders(c.a); })
      .then(function (l) { assert.strictEqual(l.length, 1); assert.strictEqual(l[0].name, 'Domain buyers'); return h.expectReject(c.svc.deleteFolder(c.b, c.folder), 'not_found'); })
      .then(function () { return c.svc.deleteFolder(c.a, c.folder); })
      .then(function (r) { assert.strictEqual(r.removed_leads, 0); });
  });
});
h.test('paste import: extracts emails, dedupes, flags invalid and role addresses', function () {
  return setup().then(function (c) {
    var data = 'John <john@good.com>, jane@good.com; info@good.com\nJOHN@good.com bad@@x.com notanemail ok@nodot';
    return c.svc.importLeads(c.a, c.folder, 'paste', data).then(function (r) {
      assert.strictEqual(r.imported, 3);
      assert.strictEqual(r.duplicates, 1);
      assert.ok(r.invalid >= 1);
      return c.svc.listLeads(c.a, c.folder, { search: 'info' });
    }).then(function (l) { assert.strictEqual(l.total, 1); assert.strictEqual(l.items[0].is_role, 1); });
  });
});
h.test('csv import: header aliases, custom columns, BOM, semicolons; existing leads skipped on re-import', function () {
  return setup().then(function (c) {
    var csvText = '﻿E-mail;First Name;Company;Niche\r\nann@good.com;Ann;Acme;crypto\r\nbob@good.com;Bob;;ai\r\nann@good.com;Ann;Acme;crypto\r\n';
    return c.svc.importLeads(c.a, c.folder, 'csv', csvText).then(function (r) {
      assert.strictEqual(r.imported, 2); assert.strictEqual(r.duplicates, 1);
      return c.db.get("SELECT first_name, company, custom FROM leads WHERE email = 'ann@good.com'");
    }).then(function (row) {
      assert.strictEqual(row.first_name, 'Ann'); assert.strictEqual(row.company, 'Acme');
      assert.deepStrictEqual(JSON.parse(row.custom), { niche: 'crypto' });
      return c.svc.importLeads(c.a, c.folder, 'csv', 'email\nann@good.com\nnew@good.com');
    }).then(function (r2) { assert.strictEqual(r2.imported, 1); assert.strictEqual(r2.duplicates, 1); });
  });
});
h.test('csv without header uses the column containing @; no email column is rejected', function () {
  return setup().then(function (c) {
    return c.svc.importLeads(c.a, c.folder, 'csv', 'Ann,ann@good.com\nBob,bob@good.com').then(function (r) {
      assert.strictEqual(r.imported, 2);
      return h.expectReject(c.svc.importLeads(c.a, c.folder, 'csv', 'name,phone\nAnn,123'), 'validation');
    }).then(function () { return h.expectReject(c.svc.importLeads(c.a, c.folder, 'csv', 'a,"b'), 'validation'); })
      .then(function () { return h.expectReject(c.svc.importLeads(c.a, c.folder, 'xlsx', 'x'), 'validation'); })
      .then(function () { return h.expectReject(c.svc.importLeads(c.a, c.folder, 'paste', ''), 'validation'); });
  });
});
h.test('cannot import into another user\'s folder', function () {
  return setup().then(function (c) { return h.expectReject(c.svc.importLeads(c.b, c.folder, 'paste', 'a@good.com'), 'not_found'); });
});
h.test('suppressed emails are skipped on import', function () {
  return setup().then(function (c) {
    return c.svc.addSuppression(c.a, ['Blocked@good.com', 'nope'], 'unsubscribed').then(function (s) {
      assert.strictEqual(s.added, 1); assert.strictEqual(s.invalid, 1);
      return c.svc.importLeads(c.a, c.folder, 'paste', 'blocked@good.com ok@good.com');
    }).then(function (r) { assert.strictEqual(r.imported, 1); assert.strictEqual(r.suppressed, 1); return c.svc.listSuppression(c.a); })
      .then(function (l) { assert.strictEqual(l.total, 1); return c.svc.removeSuppression(c.a, 'BLOCKED@good.com'); })
      .then(function (r) { assert.strictEqual(r.removed, 1); });
  });
});
h.test('stored values are sanitized: control chars, long text, HTML kept as inert text', function () {
  return setup().then(function (c) {
    var csvText = 'email,company,first name\nx@good.com,"<img src=x onerror=alert(1)>\u0007 ' + new Array(400).join('A') + '",Bob\u0000Smith\n';
    return c.svc.importLeads(c.a, c.folder, 'csv', csvText).then(function () { return c.db.get('SELECT company, first_name FROM leads'); }).then(function (r) {
      assert.ok(r.company.length <= 150);
      assert.ok(r.company.indexOf('\u0007') === -1 && r.first_name.indexOf('\u0000') === -1);
      assert.ok(r.company.indexOf('<img') === 0);      // stored as text; UI must render with textContent
    });
  });
});

h.group('leads: list, stats, export, delete');
h.test('list filters, search with LIKE wildcards escaped, pagination, bad sort ignored', function () {
  return setup().then(function (c) {
    var rows = ['email,company']; for (var i = 0; i < 25; i++) rows.push('u' + i + '@good.com,Co' + i);
    rows.push('pct@good.com,100% real'); rows.push('under@good.com,a_b');
    return c.svc.importLeads(c.a, c.folder, 'csv', rows.join('\n')).then(function () {
      return c.svc.listLeads(c.a, c.folder, { pageSize: 10, page: 3 });
    }).then(function (l) {
      assert.strictEqual(l.total, 27); assert.strictEqual(l.items.length, 7);
      return c.svc.listLeads(c.a, c.folder, { search: '%' });
    }).then(function (l) { assert.strictEqual(l.total, 1); return c.svc.listLeads(c.a, c.folder, { search: '_' }); })
      .then(function (l) { assert.strictEqual(l.total, 1); return c.svc.listLeads(c.a, c.folder, { sort: 'email; DROP TABLE leads', dir: 'asc' }); })
      .then(function (l) { assert.strictEqual(l.total, 27); return h.expectReject(c.svc.listLeads(c.a, c.folder, { status: "valid' OR '1'='1" }), 'validation'); })
      .then(function () { return h.expectReject(c.svc.listLeads(c.b, c.folder, {}), 'not_found'); });
  });
});
h.test('export neutralizes formula injection', function () {
  return setup().then(function (c) {
    return c.svc.importLeads(c.a, c.folder, 'csv', 'email,company,first name\nx@good.com,"=HYPERLINK(""http://evil"")",+cmd\n').then(function () {
      return c.svc.exportCsv(c.a, c.folder);
    }).then(function (out) {
      assert.ok(out.indexOf("'=HYPERLINK") !== -1 && out.indexOf("'+cmd") !== -1);
      assert.ok(!/(^|,)"?=HYPERLINK/.test(out));
    });
  });
});
h.test('delete leads is scoped to the owner; invalid ids rejected', function () {
  return setup().then(function (c) {
    return c.svc.importLeads(c.a, c.folder, 'paste', 'a@good.com b@good.com').then(function () { return c.db.all('SELECT id FROM leads'); }).then(function (rows) {
      var ids = rows.map(function (r) { return r.id; });
      return c.svc.deleteLeads(c.b, ids).then(function (r) { assert.strictEqual(r.deleted, 0); return h.expectReject(c.svc.deleteLeads(c.a, ['1; DROP TABLE leads']), 'validation'); })
        .then(function () { return h.expectReject(c.svc.deleteLeads(c.a, []), 'validation'); })
        .then(function () { return c.svc.deleteLeads(c.a, ids); }).then(function (r) { assert.strictEqual(r.deleted, 2); });
    });
  });
});

h.group('leads: on-demand verifier');
h.test('classifies domains, caches lookups, leaves transient DNS errors unverified, updates stats', function () {
  return setup().then(function (c) {
    var data = 'a@good.com b@good.com c@nullmx.com d@nxdomain.com e@nomx-a.com f@nomx-none.com g@flaky.com h@mailinator.com';
    lookups = {};
    return c.svc.importLeads(c.a, c.folder, 'paste', data).then(function () { return c.db.all('SELECT id FROM leads'); }).then(function (rows) {
      return c.svc.verifyLeads(c.a, rows.map(function (r) { return r.id; }));
    }).then(function (s) {
      assert.strictEqual(s.checked, 8);
      assert.strictEqual(s.valid, 2); assert.strictEqual(s.invalid, 3); assert.strictEqual(s.risky, 2); assert.strictEqual(s.retry_later, 1);
      assert.strictEqual(lookups['good.com'], 1);                                     // one DNS lookup for two leads on the same domain
      return c.db.all('SELECT email, verify_status, verify_error FROM leads ORDER BY id');
    }).then(function (rows) {
      var by = {}; rows.forEach(function (r) { by[r.email] = r; });
      assert.strictEqual(by['a@good.com'].verify_status, 'valid');
      assert.strictEqual(by['c@nullmx.com'].verify_error, 'null_mx_domain_accepts_no_mail');
      assert.strictEqual(by['d@nxdomain.com'].verify_error, 'domain_not_found');
      assert.strictEqual(by['e@nomx-a.com'].verify_status, 'risky');
      assert.strictEqual(by['g@flaky.com'].verify_status, 'unverified');             // transient: not marked invalid
      assert.ok(/dns_error_etimeout/.test(by['g@flaky.com'].verify_error));
      assert.strictEqual(by['h@mailinator.com'].verify_error, 'disposable_domain');
      return c.svc.stats(c.a, c.folder);
    }).then(function (st) {
      assert.strictEqual(st.total, 8); assert.strictEqual(st.valid, 2); assert.strictEqual(st.unverified, 1);
      assert.strictEqual(st.valid_rate, 28.6);                                         // 2 valid of 7 verified
      return c.svc.stats(c.b, null);
    }).then(function (other) { assert.strictEqual(other.total, 0); assert.strictEqual(other.valid_rate, null); });
  });
});
h.test('verify only touches the caller\'s leads and caps batch size', function () {
  return setup().then(function (c) {
    return c.svc.importLeads(c.a, c.folder, 'paste', 'a@good.com').then(function () { return c.db.get('SELECT id FROM leads'); }).then(function (row) {
      return c.svc.verifyLeads(c.b, [row.id]).then(function (s) { assert.strictEqual(s.checked, 0); return c.db.get('SELECT verify_status FROM leads'); })
        .then(function (r) { assert.strictEqual(r.verify_status, 'unverified'); });
    }).then(function () {
      var many = []; for (var i = 1; i <= 501; i++) many.push(i);
      return h.expectReject(c.svc.verifyLeads(c.a, many), 'validation');
    });
  });
});
h.test('parseInput row limits and formats', function () {
  assert.throws(function () { parseInput('csv', 'x'.repeat(12000001)); });
  assert.strictEqual(parseInput('paste', 'a@b.com, c@d.org.').length, 2);
});

h.group('leads: safe deletes and id listing');
h.test('leads waiting in a running/paused campaign cannot be deleted (lead or folder); finished campaigns do not block', function () {
  return setup().then(function (c) {
    return c.svc.importLeads(c.a, c.folder, 'paste', 'a@good.com b@good.com c@good.com').then(function () { return c.db.all('SELECT id FROM leads ORDER BY id'); }).then(function (rows) {
      var ids = rows.map(function (r) { return r.id; });
      return c.db.run("INSERT INTO campaigns (user_id, name, status, created_at, updated_at) VALUES (?, 'Run', 'active', 1, 1)", [c.a]).then(function (cr) {
        return c.db.run("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'active')", [cr.lastID, ids[0]]).then(function () {
          return h.expectReject(c.svc.deleteLeads(c.a, [ids[0], ids[1]]), 'conflict');
        }).then(function () { return h.expectReject(c.svc.deleteFolder(c.a, c.folder), 'conflict'); })
          .then(function () { return c.db.get('SELECT COUNT(*) AS n FROM leads'); }).then(function (r) { assert.strictEqual(r.n, 3, 'nothing was deleted'); })
          .then(function () { return c.svc.deleteLeads(c.a, [ids[1], ids[2]]); }).then(function (r) { assert.strictEqual(r.deleted, 2); })   // leads not in the campaign are fine
          .then(function () { return c.db.run("UPDATE campaigns SET status = 'completed' WHERE id = ?", [cr.lastID]); })
          .then(function () { return c.svc.deleteFolder(c.a, c.folder); }).then(function (r) { assert.strictEqual(r.removed_leads, 1); });
      });
    });
  });
});
h.test('leadIds returns every matching id (status filter), is scoped to the owner', function () {
  return setup().then(function (c) {
    return c.svc.importLeads(c.a, c.folder, 'paste', 'a@good.com b@nxdomain.com c@good.com').then(function () { return c.db.all('SELECT id FROM leads ORDER BY id'); }).then(function (rows) {
      return c.svc.leadIds(c.a, c.folder, { status: 'unverified' }).then(function (r) { assert.strictEqual(r.ids.length, 3); assert.strictEqual(r.truncated, false); return c.svc.verifyLeads(c.a, [rows[0].id, rows[1].id]); })
        .then(function () { return c.svc.leadIds(c.a, c.folder, { status: 'unverified' }); }).then(function (r) { assert.deepStrictEqual(r.ids, [rows[2].id]); return c.svc.leadIds(c.a, c.folder, { status: 'invalid' }); })
        .then(function (r) { assert.strictEqual(r.ids.length, 1); return h.expectReject(c.svc.leadIds(c.b, c.folder, {}), 'not_found'); })
        .then(function () { return h.expectReject(c.svc.leadIds(c.a, c.folder, { status: 'bogus' }), 'validation'); });
    });
  });
});

h.run();
