import { EventBus } from "@openfront/shared/EventBus";
import { Controller } from "../Controller";
import { TransformHandler } from "../TransformHandler";
import { SendGodActionIntentEvent } from "../Transport";
import { UIState } from "../UIState";
import { translateText } from "../Utils";
import { GameView } from "../view/GameView";

/**
 * Local/singleplayer god tool: when a brush is armed (uiState.godBrush), a
 * primary click or drag on the game canvas paints the tile under the cursor.
 *
 * Clicks are intercepted in the capture phase and swallowed so the normal
 * input handling (attack, radial menu) does not also react while painting.
 * Right-click or Escape disarms the brush.
 */
export class GodBrushController implements Controller {
  private painting = false;
  // The element the game registers its pointer input on. It is a full-screen
  // overlay div (#game-input-overlay), not the drawing canvas.
  private inputEl: EventTarget | null = null;
  private indicator: HTMLDivElement | null = null;
  private lastLabel = "";

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    private uiState: UIState,
  ) {}

  init() {
    this.inputEl =
      document.getElementById("game-input-overlay") ??
      document.querySelector("canvas");
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("contextmenu", this.onContextMenu, true);
    window.addEventListener("keydown", this.onKeyDown);
  }

  private isMapTarget(target: EventTarget | null): boolean {
    if (target === null) return false;
    if (this.inputEl !== null && target === this.inputEl) return true;
    return target instanceof HTMLCanvasElement;
  }

  private armed(): boolean {
    const brush = this.uiState.godBrush;
    return brush !== null && brush !== undefined;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.armed() || event.button !== 0) return;
    if (!this.isMapTarget(event.target)) return;
    this.painting = true;
    this.paint(event.clientX, event.clientY);
    event.stopImmediatePropagation();
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.painting || !this.armed()) return;
    this.paint(event.clientX, event.clientY);
    event.stopImmediatePropagation();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.painting) return;
    this.painting = false;
    event.stopImmediatePropagation();
  };

  private onContextMenu = (event: MouseEvent) => {
    if (!this.armed()) return;
    this.uiState.godBrush = null;
    event.stopImmediatePropagation();
    event.preventDefault();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.armed()) {
      this.uiState.godBrush = null;
    }
  };

  private paint(clientX: number, clientY: number) {
    const brush = this.uiState.godBrush;
    if (brush === null || brush === undefined) return;
    const world = this.transformHandler.screenToWorldCoordinates(
      clientX,
      clientY,
    );
    if (!this.game.isValidCoord(world.x, world.y)) return;
    const tile = this.game.ref(world.x, world.y);
    // Terrain/give/erase target a player for ownership; build/give use the god.
    const smallID = this.game.myPlayer()?.smallID() ?? 0;
    this.eventBus.emit(
      new SendGodActionIntentEvent(
        brush.action,
        smallID,
        undefined,
        tile,
        brush.unit,
      ),
    );
  }

  tick() {
    this.syncIndicator();
  }

  private syncIndicator() {
    const brush = this.uiState.godBrush;
    if (brush === null || brush === undefined) {
      this.indicator?.remove();
      this.indicator = null;
      this.lastLabel = "";
      return;
    }
    const label = `${translateText("user_setting.god_brush_active")}: ${translateText(
      `user_setting.god_brush_${brush.action}`,
    )} ${translateText("user_setting.god_brush_hint")}`;
    if (this.indicator === null) {
      this.indicator = document.createElement("div");
      this.indicator.style.cssText = [
        "position:fixed",
        "top:12px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:9999",
        "pointer-events:none",
        "padding:6px 12px",
        "border-radius:6px",
        "background:rgba(15,23,42,0.85)",
        "color:#fbbf24",
        "font-size:13px",
        "font-family:inherit",
        "white-space:nowrap",
      ].join(";");
      document.body.appendChild(this.indicator);
    }
    if (label !== this.lastLabel) {
      this.indicator.textContent = label;
      this.lastLabel = label;
    }
  }
}
