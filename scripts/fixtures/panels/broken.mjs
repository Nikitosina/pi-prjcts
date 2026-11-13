// 4, 5: ui.js throws while it loads; the version is markup that must be shown as text.
import { panelOnly } from "./fixture.mjs";
export default panelOnly("panel-broken", "<i>0.1</i>", "broken-ui.js");
