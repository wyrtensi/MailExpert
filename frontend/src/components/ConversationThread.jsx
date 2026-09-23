import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { emailFontFor } from '../utils/emailFont.js';
import { conversationSrcDoc, htmlHasQuote, personLabel, recipientsLine, splitTextQuote } from '../utils/conversationView.js';
import DirectionBadge from './DirectionBadge.jsx';
import { useMobile } from '../hooks/useMobile.js';

// The whole conversation stacked under an open letter, the way Gmail shows it: every letter of
// the thread in this mailbox, oldest first. Each letter is a card: its header (sent or received,
// who, to whom, when) and, once expanded, its text with the quoted history hidden until asked
// for. The open letter itself is only marked in its place, since it is shown in full above.
// Shown only while the "Whole conversation" box above is ticked; the box resets on every open.
export default function ConversationThread({ conversation, currentId, onOpen }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const others = conversation.items.filter((item) => item.id !== currentId);
  const [expanded, setExpanded] = useState(() => new Set());
  const allExpanded = others.length > 0 && others.every((item) => expanded.has(item.id));

  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section
      aria-label={t('message.senderHistory.threadTitle', { count: conversation.items.length })}
      style={{
        margin: isMobile ? '16px 0 0' : '20px 28px 24px',
        borderTop: '2px solid var(--accent)', paddingTop: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, padding: isMobile ? '0 12px' : 0 }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('message.senderHistory.threadTitle', { count: conversation.items.length })}
        </h3>
        {others.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(others.map((item) => item.id)))}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, fontWeight: 500, padding: 4 }}
          >
            {allExpanded ? t('message.senderHistory.threadCollapseAll') : t('message.senderHistory.threadExpandAll')}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {conversation.items.map((item) => (item.id === currentId ? (
          <div key={item.id} style={{
            padding: '8px 14px', borderRadius: 10, border: '1px dashed var(--border)',
            fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <DirectionBadge direction={item.direction} compact={isMobile} />
            <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(item.date, { withYear: !isMobile })}</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t('message.senderHistory.threadCurrent')}</span>
          </div>
        ) : (
          <ThreadLetter
            key={item.id}
            item={item}
            open={expanded.has(item.id)}
            onToggle={() => toggle(item.id)}
            onOpen={() => onOpen(item.id)}
            isMobile={isMobile}
            t={t}
          />
        )))}
      </div>
    </section>
  );
}

function ThreadLetter({ item, open, onToggle, onOpen, isMobile, t }) {
  const to = recipientsLine(item.to_addresses, item.cc_addresses);
  return (
    <article className="reading-card" style={{
      border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden',
      borderLeft: `3px solid ${item.direction === 'out' ? 'var(--accent)' : item.direction === 'in' ? 'var(--green, #22c55e)' : 'var(--border)'}`,
    }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
          padding: '10px 14px', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <DirectionBadge direction={item.direction} compact={isMobile} />
          <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
            {personLabel(item.from_name, item.from_email)}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', fontSize: 12 }}>
            {formatDateTime(item.date, { withYear: !isMobile })}
          </span>
        </div>
        {to && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('message.senderHistory.threadTo')} {to}
          </div>
        )}
        {!open && item.snippet && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.snippet}
          </div>
        )}
      </button>
      {open && <ThreadLetterBody id={item.id} onOpen={onOpen} t={t} />}
    </article>
  );
}

function ThreadLetterBody({ id, onOpen, t }) {
  const [body, setBody] = useState(null);
  const [failed, setFailed] = useState(false);
  const [showQuote, setShowQuote] = useState(false);

  useEffect(() => {
    let live = true;
    setBody(null);
    setFailed(false);
    api.getMessageBody(id)
      .then((data) => { if (live) setBody(data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id]);

  const footer = (hasQuote) => (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '8px 14px 12px', fontSize: 13 }}>
      {hasQuote && (
        <button type="button" onClick={() => setShowQuote((v) => !v)} style={linkButton}>
          {showQuote ? t('message.senderHistory.threadHideQuote') : t('message.senderHistory.threadShowQuote')}
        </button>
      )}
      <button type="button" onClick={onOpen} style={linkButton}>{t('message.senderHistory.threadOpen')}</button>
    </div>
  );

  if (failed) {
    return <div style={{ padding: '0 14px 12px', fontSize: 13, color: 'var(--red, #e53e3e)' }}>{t('message.senderHistory.threadBodyFailed')}</div>;
  }
  if (!body) {
    return <div style={{ padding: '0 14px 12px', fontSize: 13, color: 'var(--text-tertiary)' }}>{t('message.senderHistory.threadLoading')}</div>;
  }
  if (body.html) {
    return (
      <>
        <div style={{ padding: '0 14px', background: 'white' }}>
          <LetterFrame html={body.html} showQuote={showQuote} title={t('message.emailFrameTitle')} />
        </div>
        {footer(htmlHasQuote(body.html))}
      </>
    );
  }
  const { main, quote } = splitTextQuote(body.text || '');
  return (
    <>
      <div style={{
        padding: '0 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.6,
        color: '#1a1a1a', background: 'white', fontFamily: 'var(--font-sans, sans-serif)',
      }}>
        {showQuote && quote ? `${main}\n\n${quote}` : main}
      </div>
      {footer(Boolean(quote))}
    </>
  );
}

// An HTML letter in a sandboxed frame that grows to its content.
function LetterFrame({ html, showQuote, title }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(80);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    let observer = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement) setHeight(Math.max(40, doc.documentElement.scrollHeight));
    };
    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;
      if (doc?.body && typeof ResizeObserver !== 'undefined') {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(doc.body);
      }
    };
    frame.addEventListener('load', onLoad);
    return () => { frame.removeEventListener('load', onLoad); observer?.disconnect(); };
  }, []);

  return (
    <iframe
      ref={ref}
      srcDoc={conversationSrcDoc(html, { font: emailFontFor(), showQuote })}
      scrolling="no"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={title}
      style={{ width: '100%', border: 'none', display: 'block', height }}
    />
  );
}

const linkButton = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
};
