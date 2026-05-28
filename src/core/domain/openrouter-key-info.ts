export type OpenRouterKeyLimitReset =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | null;

export interface OpenRouterKeyInfo {
  readonly label?: string;
  readonly name?: string;
  readonly hash?: string;
  readonly usage?: number;
  readonly usageDaily?: number;
  readonly usageWeekly?: number;
  readonly usageMonthly?: number;
  readonly byokUsage?: number;
  readonly byokUsageDaily?: number;
  readonly byokUsageWeekly?: number;
  readonly byokUsageMonthly?: number;
  readonly limit?: number | null;
  readonly limitRemaining?: number | null;
  readonly limitReset?: OpenRouterKeyLimitReset;
  readonly includeByokInLimit?: boolean;
  readonly disabled?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string | null;
  readonly workspaceId?: string;
  readonly creatorUserId?: string;
  readonly isFreeTier?: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface OpenRouterKeyInfoResult {
  readonly keyInfo: OpenRouterKeyInfo;
  readonly checkedAtMs: number;
}