// 繁體中文（香港）catalog: the Taiwan table with Hong Kong regional vocabulary (軟件/網絡/點擊…).
import zhHantTw, { backend as twBackend } from './zh-Hant-TW.ts';

// HK differs from TW mainly in word choice, not script; keep the diff small.
const hkTerms: Record<string, string> = {
 "Agents can see, click, type and run commands in an isolated machine.": "Agent 可以在一臺隔離的機器上檢視、點擊、輸入並執行命令。",
 "Click": "點擊",
 "Click an element": "點擊一個元素",
 "Click an element to attach it. Press Esc to cancel.": "點擊一個元素即可附加。按 Esc 取消。",
 "Click to toggle actual size": "點擊切換實際大小",
 "Click where the text should start, then type. Enter adds a line; Escape finishes.": "點擊文字起點後輸入。Enter 換行，Escape 結束。",
 "Comment: click an element": "評論：點擊一個元素",
 "Drag around the device to turn it, scroll to zoom, click the screen to tap, double-click to face forward.": "拖動裝置可旋轉，滾動可縮放，點擊螢幕即點按，雙擊可轉回正面。",
 "Drag to turn · Scroll to zoom · Click the screen to tap · Double-click to face forward": "拖動旋轉 · 滾動縮放 · 點擊螢幕點按 · 雙擊轉回正面",
 "PandaCode {0} is available. Updates for this copy are installed by its package or a new AppImage.": "PandaCode {0} 已釋出。此副本的更新由其軟件包或新 AppImage 提供。",
 "Skip approval prompts and sandbox limits. Allow file and network access.": "跳過批准提示和沙箱限制。允許檔案和網絡訪問。",
 "Team mode: your selected model becomes the lead. It plans the work, starts other agents in parallel, picks a model for each worker on its own, and reviews their results. To choose the workers yourself, just say so in your prompt, like \"use Sonnet 5.5 workers\" or \"have Codex review it\". Click to turn Team on or off.": "團隊模式：你選擇的模型成為 lead。它規劃工作、並行啟動其他 Agent、自行給每個 worker 選模型，並審查它們的結果。想親自挑選 worker，直接在提示裡說明即可，例如“用 Sonnet 5.5 做 worker”或“讓 Codex 來審查”。點擊可開關團隊模式。",
 "The script is running. Preview is not ready yet; click Run to check again.": "指令碼正在執行。預覽尚未就緒；點擊 Run 再次檢查。",
 "Turn on comment mode and click an element to comment on it.": "開啟評論模式後點擊元素即可評論。",
 "VM screen. Click to use it; type while it is focused.": "虛擬機器螢幕。點擊以操作；聚焦時可輸入。",
 "iOS Simulator. Click the screen to tap, drag on it to swipe, type to enter text. Drag around the device to turn it.": "iOS 模擬器。點擊螢幕即點按，在螢幕上拖動即滑動，輸入即打字。拖動裝置四周可旋轉。"
};
const backendTerms: Record<string, string> = {};

export default { ...zhHantTw, ...hkTerms } as Record<string, string>;
export const backend = { ...twBackend, ...backendTerms } as Record<string, string>;
