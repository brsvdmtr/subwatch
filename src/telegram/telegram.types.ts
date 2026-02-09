import { RecurrenceType } from '@prisma/client';
import { Scenes } from 'telegraf';

export interface BotState {
  userId?: string;
  spaceId?: string;
  timezone?: string;
}

export interface AddSubscriptionDraft {
  title?: string;
  amountCents?: number;
  nextChargeAt?: Date;
  recurrenceType?: RecurrenceType;
  recurrenceJson?: Record<string, unknown>;
  category?: string;
  tags?: string[];
}

export interface AddSubscriptionWizardSessionData extends Scenes.WizardSessionData {
  draft?: AddSubscriptionDraft;
}

export interface BotContext extends Scenes.WizardContext<AddSubscriptionWizardSessionData> {
  state: BotState;
}
