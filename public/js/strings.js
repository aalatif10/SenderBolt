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
  testMode: 'Test mode: the whole flow runs, but no real email is sent or read.',
  engineOff: 'The sending engine is switched off. Nothing will be sent.'
};
