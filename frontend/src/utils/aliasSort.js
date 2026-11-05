// One order for every list of a mailbox's aliases (the From pickers, the alias settings, the default
// sender): alphabetical by the shown name, case-insensitive and locale-aware, then by address. An
// alias without a name sorts by the local part of its address. The mailbox's own address is not
// an alias: the lists render it first, above these.
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function nameKey(alias) {
  const name = typeof alias?.name === 'string' ? alias.name.trim() : '';
  if (name) return name;
  const email = String(alias?.email ?? '');
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

export function sortAliasesByName(aliases) {
  if (!Array.isArray(aliases)) return [];
  return [...aliases].sort((a, b) => (
    collator.compare(nameKey(a), nameKey(b))
    || collator.compare(String(a?.email ?? ''), String(b?.email ?? ''))
  ));
}
