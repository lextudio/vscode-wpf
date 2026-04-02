import * as vscode from 'vscode';

const REVIEW_PROMPT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_PROMPT_STORAGE_PREFIX = 'reviewPrompt';
const REVIEW_URL = 'https://marketplace.visualstudio.com/items?itemName=lextudio.vscode-wpf&ssr=false#review-details';

let reviewPromptTimer: NodeJS.Timeout | undefined;
let reviewPromptInFlight = false;

interface ReviewPromptState {
  readonly firstSeenAt?: number;
  readonly snoozeUntil?: number;
  readonly dismissedPermanently?: boolean;
  readonly reviewed?: boolean;
  readonly lastPromptAt?: number;
}

export function startReviewPromptScheduler(context: vscode.ExtensionContext): void {
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return;
  }

  context.subscriptions.push({
    dispose: () => {
      if (reviewPromptTimer) {
        clearTimeout(reviewPromptTimer);
        reviewPromptTimer = undefined;
      }
    },
  });

  void rescheduleReviewPrompt(context);
}

async function rescheduleReviewPrompt(context: vscode.ExtensionContext): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return;
  }

  if (reviewPromptTimer) {
    clearTimeout(reviewPromptTimer);
    reviewPromptTimer = undefined;
  }

  const now = Date.now();
  const state = await readReviewPromptState(context);
  if (state.dismissedPermanently || state.reviewed) {
    return;
  }

  const firstSeenAt = state.firstSeenAt ?? now;
  if (!state.firstSeenAt) {
    await writeReviewPromptState(context, { ...state, firstSeenAt });
  }

  const dueAt = Math.max(
    firstSeenAt + REVIEW_PROMPT_THRESHOLD_MS,
    state.snoozeUntil ?? 0
  );

  if (dueAt <= now) {
    void maybeShowReviewPrompt(context);
    return;
  }

  reviewPromptTimer = setTimeout(() => {
    void maybeShowReviewPrompt(context);
  }, dueAt - now);
}

async function maybeShowReviewPrompt(context: vscode.ExtensionContext): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return;
  }

  if (reviewPromptInFlight) {
    return;
  }

  reviewPromptInFlight = true;
  try {
    const state = await readReviewPromptState(context);
    if (state.dismissedPermanently || state.reviewed) {
      return;
    }

    const now = Date.now();
    const dueAt = Math.max(
      (state.firstSeenAt ?? now) + REVIEW_PROMPT_THRESHOLD_MS,
      state.snoozeUntil ?? 0
    );
    if (dueAt > now) {
      return;
    }

    await writeReviewPromptState(context, {
      ...state,
      lastPromptAt: now,
    });

    const choice = await vscode.window.showInformationMessage(
      'If WPF Tools has been useful for more than a week, would you like to leave a review on the VS Code Marketplace?',
      'Leave a review',
      'Remind me later',
      "Don't ask again"
    );

    if (!choice) {
      await writeReviewPromptState(context, {
        ...state,
        lastPromptAt: now,
        snoozeUntil: now + REVIEW_PROMPT_SNOOZE_MS,
      });
      return;
    }

    if (choice === 'Leave a review') {
      await writeReviewPromptState(context, {
        ...state,
        lastPromptAt: now,
        reviewed: true,
        snoozeUntil: undefined,
      });
      await vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL));
      return;
    }

    if (choice === 'Remind me later') {
      await writeReviewPromptState(context, {
        ...state,
        lastPromptAt: now,
        snoozeUntil: now + REVIEW_PROMPT_SNOOZE_MS,
      });
      return;
    }

    await writeReviewPromptState(context, {
      ...state,
      lastPromptAt: now,
      dismissedPermanently: true,
      snoozeUntil: undefined,
    });
  } finally {
    reviewPromptInFlight = false;
    void rescheduleReviewPrompt(context);
  }
}

async function readReviewPromptState(context: vscode.ExtensionContext): Promise<ReviewPromptState> {
  return {
    firstSeenAt: context.globalState.get<number>(getStorageKey('firstSeenAt')),
    snoozeUntil: context.globalState.get<number>(getStorageKey('snoozeUntil')),
    dismissedPermanently: context.globalState.get<boolean>(getStorageKey('dismissedPermanently')),
    reviewed: context.globalState.get<boolean>(getStorageKey('reviewed')),
    lastPromptAt: context.globalState.get<number>(getStorageKey('lastPromptAt')),
  };
}

async function writeReviewPromptState(
  context: vscode.ExtensionContext,
  state: ReviewPromptState
): Promise<void> {
  await Promise.all([
    context.globalState.update(getStorageKey('firstSeenAt'), state.firstSeenAt),
    context.globalState.update(getStorageKey('snoozeUntil'), state.snoozeUntil),
    context.globalState.update(getStorageKey('dismissedPermanently'), state.dismissedPermanently),
    context.globalState.update(getStorageKey('reviewed'), state.reviewed),
    context.globalState.update(getStorageKey('lastPromptAt'), state.lastPromptAt),
  ]);
}

function getStorageKey(suffix: keyof ReviewPromptState | 'lastPromptAt'): string {
  return `${REVIEW_PROMPT_STORAGE_PREFIX}.${suffix}`;
}
