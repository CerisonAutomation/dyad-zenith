import { useUserBudgetInfo } from "./useUserBudgetInfo";
import { useSettings } from "./useSettings";
import { isDyadProEnabled } from "../lib/schemas";

export function useTrialModelRestriction() {
  const { userBudget, isLoadingUserBudget } = useUserBudgetInfo();
  const { settings } = useSettings();

  const isTrial =
    (userBudget?.isTrial && settings && isDyadProEnabled(settings)) ?? false;

  return {
    isTrial,
    isLoadingTrialStatus: isLoadingUserBudget,
  };
}
