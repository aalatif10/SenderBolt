/* All user-facing wording lives here (one place to edit or translate). */
window.SB = window.SB || {};
SB.S = {
  status: {
    active: { label: 'Running', tip: 'Emails are going out on schedule.' },
    paused: { label: 'Paused', tip: 'Nothing is sent until you resume.' },
    completed: { label: 'Finished', tip: 'Every lead has finished the sequence, replied, or been stopped.' },
    draft: { label: 'Draft', tip: 'Ready to launch. Nothing has been sent yet.' },
    preparing: { label: 'Preparing', tip: 'Being set up.' },
    error: { label: 'Needs attention', tip: 'Something is blocking this campaign, for example a paused or failing sender.' },
    empty: { label: 'No campaigns yet', tip: 'Add a campaign to this project to start.' }
  },
  // Campaigns table: the status names used by the filter and the pills there (Hunter-style), with plain-language hover text.
  tableStatus: {
    active: { label: 'Active', tip: 'Emails are going out on schedule.' },
    empty: { label: 'No campaigns', tip: 'This project has no campaigns yet.' },
    archived: { label: 'Archived', tip: 'Hidden from the default view by you. Results are kept; restore it any time.' },
    preparing: { label: 'Preparing', tip: 'Being set up. It will start by itself in a moment.' },
    planned: { label: 'Planned', tip: 'Launched, but waiting for its start date. Nothing is sent before then.' },
    completed: { label: 'Completed', tip: 'Every person finished the sequence, replied, or was stopped.' },
    paused: { label: 'Paused', tip: 'Nothing is sent until you resume.' },
    error: { label: 'Error', tip: 'Something is blocking this campaign, for example a sender that cannot send. Open it to see what.' },
    draft: { label: 'Draft', tip: 'Ready to launch. Nothing has been sent yet.' }
  },
  perf: {
    scheduled: 'Emails still to go out in this campaign: first emails and follow-ups for people who have not replied or opted out.',
    sent: 'Emails successfully handed to your email provider (includes follow-ups).',
    opened: 'People who opened at least one email. Approximate: some mail apps block the tracking image. Shows "Off" when open tracking is off.',
    replied: 'People who wrote back. Out-of-office and bounce notices do not count.',
    successful: 'People you marked as Successful in the Inbox: a deal or result you won.'
  },
  metric: {
    leads: 'Total people in this project\'s campaigns.',
    sent: 'Emails successfully handed to your email provider (includes follow-ups).',
    emailed: 'People who received at least one email.',
    replied: 'People who wrote back. Out-of-office and bounce notices do not count.',
    bounced: 'Addresses that do not exist or refused the email. They are never emailed again.',
    unsub: 'People who asked to stop. They are never emailed again.',
    replyRate: 'Replies divided by people emailed.',
    bounceRate: 'Bounces divided by people emailed. Keep this under 3% to protect your Gmail accounts.',
    opens: 'People whose email loaded its tiny tracking image. Approximate: some mail apps load images automatically (inflates) and others block them (undercounts). Replies are the reliable signal.',
    progress: 'How many people have finished: replied, completed the sequence, bounced or unsubscribed.',
    next: 'When the next email in this campaign is due.'
  },
  leads: {
    status: {
      unverified: { label: 'Not checked', cls: 'draft', tip: 'This address has not been checked yet.' },
      valid: { label: 'Valid', cls: 'active', tip: 'The address is written correctly and its domain can receive email. A mailbox can still bounce, so valid is not a guarantee.' },
      invalid: { label: 'Invalid', cls: 'error', tip: 'This address cannot receive email. It is skipped by campaigns so it cannot hurt your sender accounts.' },
      risky: { label: 'Risky', cls: 'paused', tip: 'Might bounce: for example a throwaway email service or a domain without a proper mail server.' },
      catch_all: { label: 'Catch-all', cls: 'paused', tip: 'The domain accepts every address, so SenderBolt cannot tell if this person exists.' }
    },
    reasons: {
      mx_ok_domain_can_receive_mail: 'Domain can receive email.',
      null_mx_domain_accepts_no_mail: 'This domain says it accepts no email.',
      domain_not_found: 'The domain does not exist.',
      no_mx_records: 'The domain has no mail server.',
      no_mx_falls_back_to_a_record: 'No dedicated mail server, so delivery is uncertain.',
      disposable_domain: 'A throwaway email service.',
      hard_bounce: 'The address bounced when SenderBolt emailed it.',
      rejected_when_sending: 'The mail server rejected this address while sending.',
      suppressed: 'Already on your do-not-email list.',
      empty: 'Empty address.', control_characters: 'Contains hidden or line-break characters.', too_long: 'Address is too long.',
      missing_at: 'Missing the @ sign.', local_too_long: 'The part before the @ is too long.', bad_local_part: 'The part before the @ has characters that are not allowed.',
      bad_domain: 'The domain part is not valid.', bad_tld: 'The ending (like .com) is not valid.'
    },
    suppression: {
      manual: { label: 'Added by you', cls: 'draft' }, unsubscribed: { label: 'Unsubscribed', cls: 'paused' },
      bounced: { label: 'Bounced', cls: 'error' }, complaint: { label: 'Complaint', cls: 'error' }, replied_stop: { label: 'Asked to stop', cls: 'paused' }
    },
    // Turns a stored machine reason ("dns_error_etimeout", "bad_syntax_missing_at") into a plain sentence.
    reason: function (code) {
      if (!code) return '';
      var R = SB.S.leads.reasons;
      if (R[code]) return R[code];
      if (code.indexOf('bad_syntax_') === 0) return 'Not a valid email address. ' + (R[code.slice(11)] || '');
      if (code.indexOf('dns_error_') === 0) return 'Could not be checked right now (network or DNS problem). Try again later.';
      return code.replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }) + '.';
    },
    tips: {
      total: 'Everyone in this list.',
      rate: 'Valid emails divided by the emails you have checked. Aim for 90% or more.',
      valid: 'Written correctly and the domain can receive email.',
      invalid: 'Cannot receive email. Campaigns skip these automatically.',
      risky: 'Might bounce: throwaway email services and domains without a proper mail server. Catch-all domains would count here too, but spotting them needs a live mailbox probe, which SenderBolt deliberately does not do.',
      unchecked: 'Not checked yet. Use "Check emails" to find out which ones are safe to email.'
    },
    verifyNote: 'The check confirms the address is written correctly and that its domain has a mail server. It cannot confirm that the specific mailbox exists, so a few valid addresses can still bounce.'
  },
  engineOff: 'The sending engine is switched off. Nothing will be sent.',
  wizard: {
    namePlaceholder: 'Name this campaign (only you see it)', saved: 'Draft saved', saving: 'Saving\u2026', unsaved: 'Unsaved changes', conflict: 'Changed in another tab',
    conflictLong: 'This draft was changed in another tab or window, so saving here is paused to protect that version.',
    saveTip: 'Saves everything now. It also saves by itself a moment after you stop typing.', draftSaved: 'Draft saved. You can find it on Home.',
    discardTip: 'Delete this draft and leave the builder.',
    subjectPlaceholder: 'e.g. Quick question about {{company|your domain}}', subjectHint: 'Keep it short and specific. You can use fields like {{first_name|there}}.',
    followSubjectPlaceholder: 'Leave empty to reply in the same conversation', followSubjectHint: 'Empty = sent as "Re: <previous subject>", so it appears in the same conversation.',
    bodyPlaceholder: 'Write your first email here\u2026', followBodyPlaceholder: 'Write the follow-up\u2026',
    addTip: 'Adds a follow-up that is sent automatically if the person has not replied. You can add up to 5.',
    delayTip: 'Type any whole number of days from 1 to 60. The wait counts from the previous email. A follow-up is never sent to someone who has replied, bounced or unsubscribed.',
    delayEmpty: 'Type how many days to wait.', delayRange: 'Use a whole number from 1 to 60 days.',
    fieldsHelp: 'Tip: use the "Insert field" menu to personalise. {{first_name|there}} means "use the first name, or \"there\" if it is empty". {Hi|Hello} picks one of the words at random for each person.',
    previewTip: 'How the email looks for an example person (Alex Morgan, Acme Domains). Real people get their own details.', previewEmpty: 'Start typing and the preview appears here.',
    pickFolder: 'Choose at least one lead list first.', folderHint: 'Pick one or several lists. Everyone in them receives the sequence; an address that appears in two lists is emailed only once.', listsTip: 'Choose as many lists as you like. Invalid addresses, unsubscribed people and people already in a running campaign are skipped automatically.', manualTip: 'Type or paste a few people and they are saved to a list right away. No need to leave this page.', manualHelp: 'One person per line: email, first name, last name, company. Only the email is required.',
    roleHint: 'Role addresses are shared inboxes. They usually reply less and complain more.',
    eligibleTip: 'After removing invalid addresses, anyone on your suppression list, and people already in a running campaign.',
    coverageHelp: 'Those people will be skipped (and marked as errors) instead of receiving an email with a blank gap. Add a fallback like {{first_name|there}} to include them.',
    audienceAuto: 'Invalid addresses, unsubscribed people and people already in a running campaign are always left out automatically.',
    sendersHint: 'Emails rotate across the accounts you choose and respect each account\'s daily limit and warm-up.',
    weekdaysHint: 'Saturday and Sunday are skipped.', stopHint: 'Recommended. Nobody gets a follow-up after answering.', opensHint: 'Adds an invisible 1-pixel image so you can see roughly who opened. Needs your public address (SENDERBOLT_PUBLIC_ORIGIN) to work. Counts are approximate; replies are the reliable signal.',
    splitTip: 'Splits a big list into smaller batches that send side by side. People from the same company land in different batches.',
    splitHint: 'For example 26 per batch. You see the batch sizes right away.', shuffleTip: 'Mix the people differently, then show the new batch sizes.',
    testTip: 'Sends this email to you so you can check how it looks in a real inbox.',
    testIntro: 'One real email, written exactly like a campaign email, with an example person filled in (Alex Morgan, Acme Domains). The subject starts with [TEST] and nothing is added to any campaign.',
    testToHint: 'Your login address by default. Use an inbox you can open.', testNoSender: 'Add an active sender account first (Senders page); your draft is saved.',
    createTip: 'Saves the campaign without sending anything. You can start it from the project page.', startTip: 'Creates the campaign and starts sending inside your sending window.'
  },
  inbox: {
    sentiment: {
      interested: { label: 'Interested', cls: 'int', tip: 'They want to talk, buy or sell. Answer these first.' },
      more_info: { label: 'More info', cls: 'more', tip: 'They asked a question or want details before deciding.' },
      not_interested: { label: 'Not interested', cls: 'not', tip: 'They said no. They are removed from the sequence automatically.' },
      neutral: { label: 'Neutral', cls: 'neu', tip: 'Not clear yet. Read it and choose a tag yourself.' }
    },
    successful: { label: 'Successful', cls: 'int', tip: 'Click to mark this lead as Successful (a deal or result you won). Click again to undo. It is separate from the reply tag, and it lets you filter and group your wins.' },
    stopBtn: { label: 'Stop campaign', tip: 'Stops this campaign for this person only: no more emails from this campaign. Other campaigns, and the do-not-email list, are not affected.', confirm: 'Stop this campaign for this person? Other campaigns will keep emailing them. You can re-queue them later from the campaign.', done: 'Campaign stopped for this person' },
    successfulTab: 'Conversations you marked Successful.',
    kinds: { auto_reply: 'Automatic reply (out of office)', bounce: 'Delivery failure notice' },
    syncTip: 'Checks every connected mailbox for new replies right now. It also happens automatically in the background.',
    sentimentTip: 'The tag is guessed from the words. Click a different one to correct it; your choice is kept.',
    replyTip: 'Sent from the same account as the first email and threaded in the same conversation.',
    blocked: 'This person opted out or their address bounced, so replying is turned off.',
    empty: 'No replies yet. When someone answers one of your emails it shows up here, from every connected account.',
    emptyFiltered: 'No conversations match these filters.',
    plainNote: 'Replies are shown as plain text for safety.',
    showFormatted: 'View original formatting', hideFormatted: 'Hide original formatting', formattedTip: 'Shows the reply with its bold, lists and links. Scripts, images and forms are always removed.', sigTip: 'Signature added automatically by their phone or mail app. It is kept apart from what they actually wrote.', showQuoted: 'Show earlier messages',
    optNote: {
      stop_campaign: 'They replied "stop campaign". Their sequence is stopped and they are on your do-not-email list. Replying is turned off.',
      unsubscribe_link: 'They used the unsubscribe link. Their sequence is stopped and they are on your do-not-email list. Replying is turned off.',
      manual_stop: 'You stopped this campaign for this person. Nothing more will be sent from it. Other campaigns are not affected, and you can still reply.',
      bounce: 'Their address bounced. Their sequence is stopped. Replying is turned off.'
    }
  },
  settings: {
    accountTip: 'The address you sign in with.',
    passwordHint: 'At least 12 characters. Changing it signs you out everywhere else.',
    sigTip: 'Added to the end of every email from an account that has no signature of its own.',
    prefs: { intro: 'New campaigns start with these choices. You can still change them for each campaign; running campaigns are never affected.', tzTip: 'The sending window follows this time zone, usually your recipients\' or your own.' }
  },
  steps: {
    first: 'First email', follow: function (n) { return 'Follow-up ' + n; }, short: 'Email 1', shortFollow: function (n) { return 'Follow-up ' + n; },
    segTip: 'Each segment is one email in the sequence. People who replied, bounced or opted out drop out of the later segments.'
  },
  optout: {
    stop_campaign: { label: 'Stopped: replied "stop campaign"', tip: 'This person replied "stop campaign". They were removed from the sequence and added to your do-not-email list, so they will never be emailed again.' },
    unsubscribe_link: { label: 'Unsubscribed', tip: 'This person clicked the unsubscribe link. They were removed from the sequence and added to your do-not-email list.' },
    manual_stop: { label: 'Stopped: you stopped this campaign', tip: 'You stopped this person in this campaign only. No more emails from this campaign. They are not on your do-not-email list and other campaigns are not affected.' },
    bounce: { label: 'Bounced', tip: 'The address does not exist or refused the email. It was removed from the sequence and will not be tried again.' }
  },
  images: {
    tip: 'Insert a logo or picture. It travels inside the email (no download, no remote server), which keeps deliverability high.',
    title: 'Insert a picture', intro: 'Pictures are sent inside the email itself, so they show up without a "load images" prompt. Keep them small: a logo of about 100 px width is ideal.',
    upload: 'Upload a picture', empty: 'No pictures yet. Upload a PNG, JPEG, GIF or WebP file (up to 300 KB).', deleteTip: 'Delete this picture from your library. Not possible while an email or signature still uses it.',
    alt: 'Description', altTip: 'Shown when a mail app blocks pictures, and read by screen readers. Emails with described pictures are less likely to look like spam.', altPlaceholder: 'e.g. Acme Domains logo',
    width: 'Width in the email', limits: 'Up to 3 pictures per email, 300 KB each. Location data and other hidden metadata are removed automatically.',
    insert: 'Insert', choose: 'Choose a picture first.', needAlt: 'Add a short description of the picture.', tooMany: 'An email can hold up to 3 pictures. More can look like spam.',
    tooBig: 'This picture is larger than 300 KB. Heavy emails are more likely to land in spam. Please use a smaller file.', readFail: 'The file could not be read.'
  },
  studio: {
    locked: 'Already sent', lockedTip: 'This email has gone out to at least one person, so its text is frozen. People already received that wording.',
    editable: 'Not sent yet', editableTip: 'Nobody has received this email yet. You can change it freely; the next email that goes out uses your edit.',
    saved: 'Saved', unsaved: 'Unsaved changes', save: 'Save changes', saveTip: 'Applies to everyone who has not received this email yet. Takes effect on the next send.',
    liveNote: 'Changes apply to everyone who has not received this email yet.', delayShift: 'Changing the wait also moves the send time of people who are already waiting for this email.',
    leave: 'You have unsaved changes. Leave without saving?', draftNote: 'This campaign has not started. To change who receives it, the senders or the number of emails, use the builder.',
    opensOff: 'Open tracking is switched off for this campaign. Turn it on in Settings > System preferences before creating campaigns.',
    trackingInactive: 'Open tracking cannot record anything yet: the server has no public address. Set SENDERBOLT_PUBLIC_ORIGIN to the https address where SenderBolt is reachable from the internet, restart, and emails sent after that are counted. Emails already sent cannot be tracked.',
    addTip: 'Append another follow-up to this running campaign.', addNote: 'This follow-up is added to the end of the sequence. It reaches everyone who is still in the sequence once they have received the previous email; people who already finished do not get it.',
    moveIntro: 'Send these people to a campaign in this or any other project. People who already replied, bounced or opted out are skipped, and so is anyone already in the target.', moveTip: 'Move people to a campaign in any project. They leave this campaign; their history here is kept.', addCopyTip: 'Keep them in this campaign and also add them to another one.',
    removeStepTip: 'Delete this follow-up. Only possible while nobody has been sent it.', removeStepNote: 'This follow-up is deleted for everyone who has not received it yet. The emails after it move up one place and the people waiting for it continue with the next one. This cannot be undone.',
    removeNote: 'People nobody has emailed yet are taken out of the campaign. People who already received an email stay in the history but get nothing more.', removeTip: 'Stop emailing these people. Their history is kept.',
    requeueTip: 'Put people who stopped back in the queue. Works for people who replied, replied "stop campaign" (your own keyword rule) or had a problem. Never for bounces or people who used the unsubscribe link.',
    leadSaveTip: 'Updates this person everywhere they appear (their list too). Emails that have not gone out yet use the new values.', customTip: 'Extra merge fields, used as {{field_name}} in your emails. Letters, digits and underscores only.',
    settingsNote: 'Changes apply to emails that go out from now on. Emails already sent are never affected.',
    opensNote: 'Opens are estimates. Some mail apps load images automatically (inflating the count) and others block them. Replies are the reliable signal.'
  },
  reports: {
    funnelTip: 'Of the people whose first email went out in this period: how many got a follow-up, replied, were interested, bounced or opted out.',
    seriesTip: 'Emails sent and replies received on each day.', stepsTip: 'How each email in the sequence performs. Replies are attributed to the email that was sent last before the reply.',
    sentimentTip: 'How replies are tagged. The tag is guessed from the words; you can correct it in the Inbox.', weekdayTip: 'On which weekday replies arrive. Use it to pick your best sending days.'
  }
};
