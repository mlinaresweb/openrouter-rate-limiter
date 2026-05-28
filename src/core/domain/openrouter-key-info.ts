export interface OpenRouterKeyInfo {
  readonly label?: string;
  readonly usage?: number;
  readonly limit?: number | null;
  readonly limitRemaining?: number | null;
  readonly limitReset?: string | null;
  readonly isFreeTier?: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}