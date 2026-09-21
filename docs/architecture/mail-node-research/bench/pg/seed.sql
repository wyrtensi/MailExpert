-- Synthetic seed: 10,000 messages spread over 10 accounts. Bodies are built from a
-- pool of fixed sentences (not repeat('x', n) and not random bytes) so TOAST
-- compression behaves like real prose/HTML, not a degenerate best/worst case.
-- body_text targets ~4 KB, body_html ~20 KB (HTML boilerplate + repeated paragraphs,
-- which is what real newsletter/mail HTML looks like — heavy on repeated inline
-- style attributes, which is exactly what compresses well).

INSERT INTO email_accounts SELECT gen_random_uuid() FROM generate_series(1, 10);

DO $$
DECLARE
  sentences TEXT[] := ARRAY[
    'Thank you for reaching out, we wanted to give you a quick update on the status of your recent request.',
    'Our team has reviewed the details you provided and everything looks like it is on track for this week.',
    'Please let us know if you have any questions or if there is anything else we can help you with today.',
    'We appreciate your patience while we work through the backlog of tickets from the past few days.',
    'A member of our support staff will follow up with you shortly to confirm the next steps in this process.',
    'This message is a friendly reminder that your subscription will renew automatically at the end of the month.',
    'You can review your account settings and billing history at any time from the dashboard linked below.',
    'We have attached a summary of the changes that were made along with the reasoning behind each decision.',
    'If this was not something you requested, please contact our security team immediately using the link provided.',
    'Our engineering team is actively monitoring the situation and will post updates as they become available.',
    'Thanks again for being a loyal customer, we could not do this without people like you supporting the project.',
    'The meeting has been rescheduled to next Tuesday at the same time, please update your calendar accordingly.',
    'Attached you will find the invoice for last month along with a breakdown of usage across all services.',
    'We are excited to announce a handful of new features that should make your day to day workflow easier.',
    'As always, feel free to reply directly to this email if you would like to speak with someone on the team.',
    'Your package has shipped and should arrive within three to five business days depending on your location.',
    'We noticed some unusual activity on your account and wanted to check in to make sure everything is fine.',
    'The quarterly report is now available and includes highlights from each of the regional sales teams.',
    'Please find below a list of action items that came out of yesterday afternoon planning session.',
    'We are sorry for the inconvenience this may have caused and appreciate your understanding while we fix it.',
    'Here is a short recap of what we covered on the call along with links to the relevant documentation.',
    'Congratulations on completing the onboarding checklist, you are now ready to invite the rest of your team.',
    'This is an automated notification, please do not reply directly as this mailbox is not monitored.',
    'We wanted to let you know that scheduled maintenance will take place this weekend starting Saturday night.',
    'Below is a summary of the changes included in this release along with a few notes on known issues.',
    'Your feedback means a lot to us and directly shapes what we choose to prioritize in future releases.',
    'A new comment was added to the thread you are following, click through to see the full conversation.',
    'We put together a short guide that walks through the most common questions we have received this month.',
    'The event has been moved to a larger venue to accommodate the number of people who have registered.',
    'Please review the attached document and let us know if you have any edits before we send it out.'
  ];
  html_style TEXT := 'margin:0 0 12px 0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#333333;';
  acct_ids UUID[];
  i INT;
  j INT;
  n_sent INT;
  n_html INT;
  body_txt TEXT;
  body_htm TEXT;
  pool_len INT;
  s TEXT;
BEGIN
  SELECT array_agg(id) INTO acct_ids FROM email_accounts;
  pool_len := array_length(sentences, 1);

  FOR i IN 1..10000 LOOP
    n_sent := 30 + floor(random() * 15)::int; -- ~30-45 sentences, ~3.5-5 KB
    body_txt := '';
    FOR j IN 1..n_sent LOOP
      body_txt := body_txt || sentences[1 + floor(random() * pool_len)::int] || ' ';
    END LOOP;

    n_html := 65 + floor(random() * 25)::int; -- ~65-90 paragraphs, ~18-23 KB
    body_htm := '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;">';
    FOR j IN 1..n_html LOOP
      body_htm := body_htm || '<p style="' || html_style || '">' ||
        sentences[1 + floor(random() * pool_len)::int] || '</p>';
    END LOOP;
    body_htm := body_htm || '</div>';

    s := sentences[1 + floor(random() * pool_len)::int];

    INSERT INTO messages (
      account_id, uid, folder, message_id, subject, from_name, from_email,
      to_addresses, cc_addresses, date, snippet, body_text, body_html,
      is_read, is_starred, has_attachments, sender_email, sender_name
    ) VALUES (
      acct_ids[1 + floor(random() * array_length(acct_ids, 1))::int],
      i,
      'INBOX',
      'msg-' || i || '-' || substr(md5(random()::text), 1, 12) || '@example.com',
      'Re: ' || left(s, 60) || ' (#' || i || ')',
      'Sender Name ' || (i % 500),
      'sender' || (i % 500) || '@example.com',
      ('[{"name":"Recipient","address":"user' || (i % 500) || '@example.com"}]')::jsonb,
      '[]'::jsonb,
      NOW() - (random() * interval '365 days'),
      left(s, 180),
      body_txt,
      body_htm,
      (random() < 0.6),
      (random() < 0.1),
      (random() < 0.15),
      'sender' || (i % 500) || '@example.com',
      'Sender Name ' || (i % 500)
    );
  END LOOP;
END $$;

VACUUM ANALYZE messages;
