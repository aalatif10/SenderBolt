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
    pickFolder: 'Choose a lead folder first.', folderHint: 'People in this folder receive the sequence. Add or verify leads on the Leads page.',
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
    kinds: { auto_reply: 'Automatic reply (out of office)', bounce: 'Delivery failure notice' },
    syncTip: 'Checks every connected mailbox for new replies right now. It also happens automatically in the background.',
    sentimentTip: 'The tag is guessed from the words. Click a different one to correct it; your choice is kept.',
    replyTip: 'Sent from the same account as the first email and threaded in the same conversation.',
    blocked: 'This person opted out or their address bounced, so replying is turned off.',
    empty: 'No replies yet. When someone answers one of your emails it shows up here, from every connected account.',
    emptyFiltered: 'No conversations match these filters.',
    plainNote: 'Replies are shown as plain text for safety.'
  },
  settings: {
    accountTip: 'The address you sign in with.',
    passwordHint: 'At least 12 characters. Changing it signs you out everywhere else.',
    sigTip: 'Added to the end of every email from an account that has no signature of its own.'
  }
};
