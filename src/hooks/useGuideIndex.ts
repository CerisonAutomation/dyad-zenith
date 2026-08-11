import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";

export interface GuideEntry {
  slug: string;
  title: string;
  description: string;
}

export function useGuideIndex() {
  const { data, isLoading } = useQuery({
    queryKey: ["prompts", "guides"],
    queryFn: async (): Promise<GuideEntry[]> => {
      return ipc.prompt.listGuides();
    },
    meta: { showErrorToast: false },
  });
  return { guides: data ?? [], isLoading };
}
