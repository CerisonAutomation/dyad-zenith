import { ipc } from "@/ipc/types";
import { useFreeAgentQuota } from "@/hooks/useFreeAgentQuota";
import { useFreeModelQuota } from "@/hooks/useFreeModelQuota";
import {
  X,
  ExternalLink as ExternalLinkIcon,
  CircleArrowUp,
  MessageSquarePlus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ChatErrorBox({
  onDismiss,
  error,
  isDyadProEnabled: _isDyadProEnabled,
  onStartNewChat,
}: {
  onDismiss: () => void;
  error: string;
  isDyadProEnabled: boolean;
  onStartNewChat?: () => void;
}) {
  const fallbackPrefix = "Fallbacks=[{";
  const normalizedError = error.includes(fallbackPrefix)
    ? error.split(fallbackPrefix)[0]
    : error;
  const isFreeModelQuotaError =
    normalizedError.includes("dyad_free_model_quota_exceeded") ||
    normalizedError.includes("FREE_MODEL_QUOTA_EXCEEDED") ||
    normalizedError.includes("Dyad Free has reached its daily limit.") ||
    normalizedError.includes("Dyad Free limit");
  const { messagesLimit } = useFreeAgentQuota();
  const {
    messagesLimit: freeModelMessagesLimit,
    resetTime: freeModelResetTime,
  } = useFreeModelQuota({ enabled: isFreeModelQuotaError });

  if (
    error.includes("Resource has been exhausted") ||
    error.includes("https://ai.google.dev/gemini-api/docs/rate-limits") ||
    error.includes("Provider returned error")
  ) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        {error}
        <div className="mt-2 space-y-2 space-x-2">
          <ExternalLink href="https://dyad.sh/docs/help/ai-rate-limit">
            Troubleshooting guide
          </ExternalLink>
        </div>
      </ChatErrorContainer>
    );
  }

  if (error.includes("LiteLLM Virtual Key expected")) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>
          Looks like you don't have a valid API key configured. Check your
          provider settings.
        </span>
      </ChatInfoContainer>
    );
  }
  if (error.includes("ExceededBudget:")) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>
          You have used all of your AI credits this month. Switch to a different
          model or wait for your quota to reset.
        </span>
      </ChatInfoContainer>
    );
  }
  // This is a very long list of model fallbacks that clutters the error message.
  //
  // We are matching "Fallbacks=[{" and not just "Fallbacks=" because the fallback
  // model itself can error and we want to include the fallback model error in the error message.
  // Example: https://github.com/dyad-sh/dyad/issues/1849#issuecomment-3590685911
  if (error.includes(fallbackPrefix)) {
    error = normalizedError;
  }
  // Handle FREE_AGENT_QUOTA_EXCEEDED error (Basic Agent mode quota exceeded)
  if (error.includes("FREE_AGENT_QUOTA_EXCEEDED")) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        You have used all {messagesLimit} free Agent messages for today. Please
        switch to Build mode or try again later.
        <div className="mt-2 space-y-2 space-x-2">
          {onStartNewChat && (
            <Tooltip>
              <TooltipTrigger
                onClick={onStartNewChat}
                className="cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500"
              >
                <span>Start new chat</span>
                <MessageSquarePlus size={18} />
              </TooltipTrigger>
              <TooltipContent>
                Starting a new chat can fix some issues
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </ChatErrorContainer>
    );
  }

  if (isFreeModelQuotaError) {
    const resetText = freeModelResetTime
      ? ` Your quota resets at ${new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(freeModelResetTime))}.`
      : "";

    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        <span>
          You have reached the {freeModelMessagesLimit}-message free model
          limit.
          {resetText} Switch to a different model or wait for your quota to
          reset.
        </span>
      </ChatErrorContainer>
    );
  }

  return (
    <ChatErrorContainer onDismiss={onDismiss}>
      {error}
      <div className="mt-2 space-y-2 space-x-2">
        {onStartNewChat && (
          <Tooltip>
            <TooltipTrigger
              onClick={onStartNewChat}
              className="cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500"
            >
              <span>Start new chat</span>
              <MessageSquarePlus size={18} />
            </TooltipTrigger>
            <TooltipContent>
              Starting a new chat can fix some issues
            </TooltipContent>
          </Tooltip>
        )}
        <ExternalLink href="https://www.dyad.sh/docs/faq">
          Read docs
        </ExternalLink>
      </div>
    </ChatErrorContainer>
  );
}

function ExternalLink({
  href,
  children,
  variant = "secondary",
  icon,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  icon?: React.ReactNode;
}) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const primaryClasses =
    "bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500";
  const secondaryClasses =
    "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 focus:ring-blue-200";
  const iconElement =
    icon ??
    (variant === "primary" ? (
      <CircleArrowUp size={18} />
    ) : (
      <ExternalLinkIcon size={14} />
    ));

  return (
    <a
      className={`${baseClasses} ${variant === "primary" ? primaryClasses : secondaryClasses}`}
      onClick={() => ipc.system.openExternalUrl(href)}
    >
      <span>{children}</span>
      {iconElement}
    </a>
  );
}

function ChatErrorContainer({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode | string;
}) {
  return (
    <div
      data-testid="chat-error-box"
      className="relative mt-2 bg-red-50 border border-red-200 rounded-md shadow-sm p-2 mx-4"
    >
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-red-100 rounded"
      >
        <X size={14} className="text-red-500" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-red-700 text-wrap">
          {typeof children === "string" ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children: linkChildren, ...props }) => (
                  <a
                    {...props}
                    onClick={(e) => {
                      e.preventDefault();
                      if (props.href) {
                        ipc.system.openExternalUrl(props.href);
                      }
                    }}
                    className="text-blue-500 hover:text-blue-700"
                  >
                    {linkChildren}
                  </a>
                ),
              }}
            >
              {children}
            </ReactMarkdown>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

function ChatInfoContainer({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative mt-2 bg-sky-50 border border-sky-200 rounded-md shadow-sm p-2 mx-4">
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-sky-100 rounded"
      >
        <X size={14} className="text-sky-600" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-sky-800 text-wrap">{children}</div>
      </div>
    </div>
  );
}
