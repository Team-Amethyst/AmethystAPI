import licensingInner from "../content/licensing-inner.html?raw";

export function LicensingTab() {
  return (
    <div className="tab-content active" id="tab-licensing">
      <div className="portal-shell" dangerouslySetInnerHTML={{ __html: licensingInner }} />
    </div>
  );
}
