import ImapProviderAddForm from './ImapProviderAddForm.jsx';

// "Other": address and password are visible at once; the IMAP/SMTP servers live in the same
// collapsed advanced block as every other service and are required, so "Connect" stays disabled
// until they are filled. Open to every approved employee; the request is the verified manual route
// (POST /api/accounts), which checks IMAP and SMTP before anything is saved. No TLS-bypass control.
export default function ManualAccountAddForm(props) {
  return <ImapProviderAddForm {...props} provider="other" catalog={null} />;
}
