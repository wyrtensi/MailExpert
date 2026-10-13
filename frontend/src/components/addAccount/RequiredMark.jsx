// The input's required attribute announces the requirement; this mark is decorative.
export default function RequiredMark() {
  return <span className="add-account-required" data-required-mark aria-hidden="true">*</span>;
}
