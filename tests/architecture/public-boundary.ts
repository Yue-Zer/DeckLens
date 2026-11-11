// Compile-only architecture checks. No runtime imports or user-data access.
import type {
  ExploreNodeKind,
  ExploreViewState,
  ChatSourceRef,
  PlatformAdapter,
  ProviderPublicDto,
  SourceRef,
} from "../../packages/contracts/src/vnext/design.js";

type Assert<T extends true> = T;
type Lacks<T, K extends PropertyKey> = Extract<keyof T, K> extends never ? true : false;
export type PublicProviderHasNoSecret = Assert<Lacks<ProviderPublicDto,
  "apiKey" | "secretRef" | "credentialRef" | "authorization" | "headers">>;
export type AdapterHasNoEscapeHatch = Assert<Lacks<PlatformAdapter,
  "invoke" | "readFile" | "execute" | "getKey" | "setKey" | "generate">>;
export type FixedPanelHasNoFloatingState = Assert<Lacks<ExploreViewState, "floatingCards">>;
export type TermSourceNeedsNoChat = Assert<Lacks<SourceRef, "grantId" | "chatId" | "ownerDocumentId">>;
export type ChatEvidenceRequiresScope = Assert<
  ChatSourceRef extends Required<Pick<ChatSourceRef, "grantId" | "chatId" | "ownerDocumentId" | "role">> ? true : false>;
export type ActionNamesAreCanonical = Assert<
  Exclude<"deepen" | "relate" | "branch", ExploreNodeKind> extends never ? true : false>;
