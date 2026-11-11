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
    opens: 'Open tracking is not available. Replies are the reliable signal of interest.',
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
  testMode: 'Test mode: the whole flow runs, but no real email is sent or read.',
  engineOff: 'The sending engine is switched off. Nothing will be sent.'
};
