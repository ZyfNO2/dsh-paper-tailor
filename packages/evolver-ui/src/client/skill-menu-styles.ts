/** Keep the native slash-menu descriptions legible over the light research canvas.
 * Use semantic roles and stable option IDs, never a version-specific CSS hash.
 * light-dark follows the Host's selected color-scheme, including explicit overrides.
 */
export function ensureResearchSkillMenuStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('dsh-paper-skill-menu-style')) return;
  const style = document.createElement('style');
  style.id = 'dsh-paper-skill-menu-style';
  style.textContent = `
    [role="listbox"]:has([id^="dsh-slash-option-skill-"]) {
      background:light-dark(#ffffff,#20242d);
      border:1px solid light-dark(#cbd5e1,#475569);
      color:light-dark(#172033,#f8fafc);
    }
    [role="listbox"] [id^="dsh-slash-option-skill-"] > span + span {
      color:light-dark(#475569,#d5dce7);
      opacity:1;
    }
    [role="listbox"] [id^="dsh-slash-option-skill-"][aria-selected="true"] {
      background:light-dark(#eef2ff,#354156);
    }
  `;
  document.head.appendChild(style);
}
