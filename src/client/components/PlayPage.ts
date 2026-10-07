import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { isLocalMode } from "../LocalMode";
import "./CosmeticBackground";
import "./NavAccountMenu";
import "./NavUtilityIcons";
import "./NewsBox";
import "./SteamWishlist";
import "./StreamingNow";

@customElement("play-page")
export class PlayPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    // A local-only build renders a slimmer home page. Not cosmetic: the pieces
    // dropped here are the ones that do work after the page loads — the news
    // box and the stream row fetch JSON, and the account menu only ever leads
    // somewhere an API has to answer. Each is a request that cannot succeed and
    // a control that cannot be used, so it is left out rather than rendered
    // dead. The identity row stays: the name on it is what the room seats you
    // under.
    const local = isLocalMode();
    return html`
      <div
        id="page-play"
        class="flex flex-col gap-2 w-full px-0 lg:px-4 min-h-0"
      >
        ${local
          ? nothing
          : html`
              <token-login class="absolute"></token-login>
              <rewards-modal class="absolute"></rewards-modal>
            `}

        <!-- Mobile: Fixed top bar -->
        <div
          class="lg:hidden fixed left-0 right-0 top-[var(--top-ad-height,0px)] z-40 pt-[env(safe-area-inset-top)] bg-surface border-b border-white/10"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center h-14 px-2 gap-2"
          >
            <button
              id="hamburger-btn"
              class="col-start-1 justify-self-start h-10 shrink-0 aspect-[4/3] flex text-white/90 rounded-md items-center justify-center transition-colors"
              data-i18n-aria-label="main.menu"
              aria-expanded="false"
              aria-controls="sidebar-menu"
              aria-haspopup="dialog"
              data-i18n-title="main.menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-8"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>

            <div
              class="col-start-2 flex items-center justify-center text-malibu-blue min-w-0"
            >
              <img
                src=${assetUrl("images/OpenFrontLogo.svg")}
                alt="OpenFront"
                class="h-full w-auto"
              />
            </div>

            <!-- Right slot: help and settings. The account affordance is dropped
                 on the local build — signing in is the only thing it leads to. -->
            <div
              class="col-start-3 justify-self-end shrink-0 flex items-center gap-0.5"
            >
              <nav-utility-icons size="mobile"></nav-utility-icons>
              ${local
                ? nothing
                : html`<nav-account-menu variant="mobile"></nav-account-menu>`}
            </div>
          </div>
        </div>

        <!-- Top strip: identity only. News and Streaming Now are online feed
             chrome, so the left column IS the row here — the grid only ever
             took two columns while the stream panel was live. -->
        <div
          class="w-full pb-4 lg:pb-0 flex flex-col gap-4 sm:-mx-4 sm:w-[calc(100%+2rem)] lg:mx-0 lg:w-full"
        >
          <!-- Mobile: spacer for fixed top bar -->
          <div
            class="lg:hidden h-[calc(env(safe-area-inset-top)+56px)] -mb-4"
          ></div>

          ${local
            ? nothing
            : html`<div class="flex flex-col gap-2 min-w-0">
                <news-box></news-box>
              </div>`}

          <!-- Identity row: username over the currently selected cosmetic background. -->
          <div
            class="relative bg-surface border-y border-white/10 overflow-visible flex items-center sm:min-h-[60px] sm:flex-1 sm:z-20 sm:border-y-0 sm:rounded-xl"
          >
            <!-- Selected skin/pattern fills the bubble like the player's territory in game. -->
            <cosmetic-background
              class="absolute inset-0 z-0 overflow-hidden sm:rounded-xl pointer-events-none"
            ></cosmetic-background>
            <div
              class="relative z-10 flex h-full w-full min-w-0 items-center bg-surface/80 p-1 sm:rounded-xl"
            >
              <username-input
                class="flex-1 min-w-0 h-10 sm:h-[50px]"
              ></username-input>
            </div>
          </div>

          ${local
            ? nothing
            : html`<streaming-now
                class="hidden lg:flex lg:h-full lg:flex-col w-full min-w-0"
              ></streaming-now>`}
        </div>

        <game-mode-selector></game-mode-selector>

        ${local
          ? nothing
          : html`<steam-wishlist
              campaign="home_mobile"
              class="block px-2 pb-4 lg:hidden"
            ></steam-wishlist>`}
      </div>
    `;
  }
}
