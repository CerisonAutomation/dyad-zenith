import { useQuery } from "@tanstack/react-query";
import { languageModelClient } from "@/ipc/types/language-model";

/**
 * Hook that auto-discovers models from all configured providers by querying
 * their APIs.  Returns a Record mapping provider IDs to arrays of LanguageModel
 * objects.  Caches results for 5 minutes; errors are logged but silently
 * swallowed so the UI stays usable.
 */
export function useAutoDiscoverModels() {
  return useQuery({
    queryKey: ["auto-discover-models"],
    queryFn: () => languageModelClient.autoDiscoverModels(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
