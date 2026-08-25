import { useRef } from "react";
import ChatView from "./ChatView";
import useChatCoreState from "./useChatCoreState";
import useChatPresenceState from "./useChatPresenceState";
import useChatInteractionState from "./useChatInteractionState";
import useChatIdentity from "./useChatIdentity";
import useChatSenderIdentity from "./useChatSenderIdentity";
import useChatLayoutState from "./useChatLayoutState";
import useChatRuntimeRefs from "./useChatRuntimeRefs";
import useChatModerationReadState from "./useChatModerationReadState";
import useChatScrollTracking from "./useChatScrollTracking";
import useChatSubscriptionLifecycle from "./useChatSubscriptionLifecycle";
import useChatPersistenceLifecycle from "./useChatPersistenceLifecycle";
import useChatQueueStatus from "./useChatQueueStatus";
import useChatFeedbackLifecycle from "./useChatFeedbackLifecycle";
import useChatDraftTypingLifecycle from "./useChatDraftTypingLifecycle";
import useChatTextSending from "./useChatTextSending";
import useChatRetryDelivery from "./useChatRetryDelivery";
import useChatManualSync from "./useChatManualSync";
import useChatImageSending from "./useChatImageSending";
import useChatImagePicker from "./useChatImagePicker";
import useChatReactions from "./useChatReactions";
import useChatMessageSelection from "./useChatMessageSelection";
import useChatReporting from "./useChatReporting";
import useChatModerationActions from "./useChatModerationActions";
import useChatHistory from "./useChatHistory";
import useChatMessageGrouping from "./useChatMessageGrouping";
import useChatSearchResults from "./useChatSearchResults";
import useChatMessageNavigation from "./useChatMessageNavigation";
import useChatNavigationLifecycle from "./useChatNavigationLifecycle";
import useChatMessageRenderer from "./useChatMessageRenderer";
import useChatTimelineRenderer from "./useChatTimelineRenderer";
import useChatEmptyRenderer from "./useChatEmptyRenderer";
export default function ChatController({
  onBack,
  tourId,
  bookingData,
  tourData,
  internalDriverChat = false,
  initialMessageId = null,
  identityBinding: identityBindingProp = null,
  canonicalIdentity: canonicalIdentityProp = null,
  isConnected = true,
  offlineSessionScope = null
}) {
  const late = useRef({});
  Object.assign(late.current, {
    onBack,
    tourId,
    bookingData,
    tourData,
    internalDriverChat,
    initialMessageId,
    identityBindingProp,
    canonicalIdentityProp,
    isConnected,
    offlineSessionScope
  });
  useChatCoreState(late.current, late);
  useChatPresenceState(late.current, late);
  useChatInteractionState(late.current, late);
  useChatIdentity(late.current, late);
  useChatSenderIdentity(late.current, late);
  useChatLayoutState(late.current, late);
  useChatRuntimeRefs(late.current, late);
  useChatModerationReadState(late.current, late);
  useChatScrollTracking(late.current, late);
  useChatSubscriptionLifecycle(late.current, late);
  useChatPersistenceLifecycle(late.current, late);
  useChatQueueStatus(late.current, late);
  useChatFeedbackLifecycle(late.current, late);
  useChatDraftTypingLifecycle(late.current, late);
  useChatTextSending(late.current, late);
  useChatRetryDelivery(late.current, late);
  useChatManualSync(late.current, late);
  useChatImageSending(late.current, late);
  useChatImagePicker(late.current, late);
  useChatReactions(late.current, late);
  useChatMessageSelection(late.current, late);
  useChatReporting(late.current, late);
  useChatModerationActions(late.current, late);
  useChatHistory(late.current, late);
  useChatMessageGrouping(late.current, late);
  useChatSearchResults(late.current, late);
  useChatMessageNavigation(late.current, late);
  useChatNavigationLifecycle(late.current, late);
  useChatMessageRenderer(late.current, late);
  useChatTimelineRenderer(late.current, late);
  useChatEmptyRenderer(late.current, late);
  return <ChatView {...late.current} />;
}
