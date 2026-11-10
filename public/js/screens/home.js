/* Home: "what should I do now?" + live tiles + projects. Refreshes every 10 s while the tab is visible. */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;
  SB.screens = SB.screens || {};

  function newProjectModal() {
    var name = h('input', { class: 'input', id: 'np-name', maxlength: 100, placeholder: 'e.g. Q4 domain outreach' });
    var desc = h('textarea', { class: 'input', id: 'np-desc', maxlength: 500, placeholder: 'Optional notes for yourself' });
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var body = h('div', null, err,
      h('div', { class: 'field' }, h('label', { for: 'np-name' }, 'Project name'), name),
      h('div', { class: 'field' }, h('label', { for: 'np-desc' }, 'Description'), desc),
      h('p', { class: 'small muted', text: 'A project groups related campaigns (for example different versions of the same email) so you can see their results together.' }));
    ui.modal({ title: 'New project', body: body, actions: [
      { label: 'Cancel' },
      { label: 'Create project', kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        return SB.api.post('/api/projects', { name: name.value, description: desc.value }).then(function (r) { close(); location.hash = '#/project/' + r.project.id; }, function (e) {
          err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e;
        });
      } }
    ] });
    return name;
  }

  function projectCard(p) {
    var t = p.totals;
    return h('a', { class: 'card project-card', href: '#/project/' + p.id },
      h('div', { class: 'top' }, h('h3', { text: p.name }), ui.statusPill(p.status)),
      p.campaign_count ? ui.progress(t.progress_pct) : h('div', { class: 'small faint', text: 'No campaigns yet' }),
      h('div', { class: 'kv' },
        h('span', { tip: SB.S.metric.sent }, h('b', { text: fmt.num(t.sent) }), 'sent'),
        h('span', { tip: SB.S.metric.replied }, h('b', { text: fmt.num(t.replied) }), 'replies'),
        h('span', { tip: SB.S.metric.bounced }, h('b', { text: fmt.num(t.bounced) }), 'bounced'),
        h('span', { tip: SB.S.metric.next }, h('b', { text: fmt.until(t.next_send_at) }), 'next email')));
  }

  function nextStep(senders, leadsTotal, projects) {
    var s;
    if (!senders.length) s = { t: 'Connect your first Gmail account', d: 'SenderBolt sends from your own accounts using a Google App Password.', l: 'Add a sender', h: '#/senders' };
    else if (!leadsTotal) s = { t: 'Add the people you want to contact', d: 'Paste emails or import a CSV file into a folder.', l: 'Add leads', h: '#/leads' };
    else if (!projects) s = { t: 'Create your first project', d: 'A project holds your campaigns and shows their results together.', l: 'New project', act: true };
    if (!s) return null;
    var btn = s.act ? h('button', { class: 'btn btn-primary', type: 'button', on: { click: newProjectModal } }, SB.icon('plus'), s.l) : h('a', { class: 'btn btn-primary', href: s.h }, s.l);
    return h('div', { class: 'card next-step' }, h('div', { class: 'txt' }, h('h2', { text: 'Next step: ' + s.t }), h('p', { class: 'muted', text: s.d })), btn);
  }

  SB.screens.home = function () {
    var root = h('div'), body = h('div', null, h('div', { class: 'skeleton' }));
    var head = h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Home' }), h('p', { class: 'sub', text: 'Your outreach at a glance.' })),
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: newProjectModal } }, SB.icon('plus'), 'New project'));
    root.appendChild(head); root.appendChild(body);

    function render(r) {
      var senders = r[1].items, projects = r[0].items, leads = r[2].stats.total, unread = r[3].unread;
      var today = fmt.todayUtc(), sent = 0, cap = 0;
      senders.forEach(function (s) { if (s.status === 'active') { cap += s.daily_limit; if (s.sent_today_date === today) sent += s.sent_today; } });
      var badSenders = senders.filter(function (s) { return s.status !== 'active' || s.last_error; });
      var attn = badSenders.length + (r[0].counts.error || 0);
      var attnNote = badSenders.length ? badSenders[0].label + ': ' + (badSenders[0].last_error || (badSenders[0].status === 'paused' ? 'paused' : badSenders[0].status)) : (r[0].counts.error ? 'A campaign is blocked' : 'Everything looks healthy');
      var tiles = h('div', { class: 'grid-tiles' },
        ui.tile('Sent today', fmt.num(sent), cap ? 'of ' + fmt.num(cap) + ' daily capacity' : 'No active sender', 'Emails sent today across all your senders, compared with what they are allowed to send per day.'),
        ui.tile('Replies waiting', fmt.num(unread), unread ? 'Unread conversations' : 'You are all caught up', 'Conversations with a reply you have not opened yet.'),
        ui.tile('Projects running', fmt.num(r[0].counts.active), 'of ' + fmt.num(projects.length) + ' projects', 'Projects with at least one campaign currently sending.'),
        ui.tile('Needs attention', fmt.num(attn), attnNote, 'Senders that are paused or reporting an error, and campaigns that are blocked.', attn > 0));
      var list = projects.length
        ? h('div', { class: 'project-grid' }, projects.map(projectCard))
        : h('div', { class: 'card empty' }, h('h2', { text: 'No projects yet' }), h('p', { text: 'Create a project to organise your campaigns and see their results in one place.' }),
          h('button', { class: 'btn btn-primary', type: 'button', on: { click: newProjectModal } }, SB.icon('plus'), 'New project'));
      SB.mount(body, h('div', null, nextStep(senders, leads, projects.length), tiles, h('div', { class: 'section-title' }, h('h2', { text: 'Projects' })), list));
    }

    function load() {
      return Promise.all([SB.api.get('/api/projects'), SB.api.get('/api/senders'), SB.api.get('/api/stats'), SB.api.get('/api/inbox?limit=1')]).then(render, function (e) {
        if (e.code !== 'offline') SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    return { el: root, destroy: ui.poll(load, 10000) };
  };
})();
