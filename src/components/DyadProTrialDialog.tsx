interface DyadProTrialDialogProps {
  isOpen: boolean;
  onClose: () => void;
  utmCampaign?: string;
}

/** Stripped — Pro is always enabled. Dialog is inert. */
export function DyadProTrialDialog({
  onClose: _onClose,
}: DyadProTrialDialogProps) {
  return null;
}
