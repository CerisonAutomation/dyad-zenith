import { usePrompts } from "@/hooks/usePrompts";
import { useGuideIndex } from "@/hooks/useGuideIndex";
import { useAddPromptDeepLink } from "@/hooks/useAddPromptDeepLink";
import { CreatePromptDialog } from "@/components/CreatePromptDialog";
import { UploadPromptDialog } from "@/components/UploadPromptDialog";
import { LibraryCard } from "@/components/LibraryCard";

export default function LibraryPage() {
  const { prompts, isLoading, createPrompt, updatePrompt, deletePrompt } =
    usePrompts();
  const { guides, isLoading: guidesLoading } = useGuideIndex();
  const { prefillData, dialogOpen, handleDialogClose } = useAddPromptDeepLink();

  return (
    <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-bold sm:text-3xl">Library: Prompts</h1>
          <div className="shrink-0 flex gap-2">
            <UploadPromptDialog onUploadPrompt={createPrompt} />
            <CreatePromptDialog
              onCreatePrompt={createPrompt}
              prefillData={prefillData}
              isOpen={dialogOpen}
              onOpenChange={handleDialogClose}
            />
          </div>
        </div>

        {!guidesLoading && guides.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Built-in guides
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {guides.map((g) => (
                <div
                  key={g.slug}
                  className="rounded-lg border bg-(--background-lightest) p-4 dark:bg-zinc-900"
                >
                  <div className="mb-1 font-medium">{g.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {g.description}
                  </div>
                  <div className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    read_guide: {g.slug}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {isLoading ? (
          <div>Loading...</div>
        ) : prompts.length === 0 ? (
          <div className="text-muted-foreground">
            No prompts yet. Create one to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {prompts.map((p) => (
              <LibraryCard
                key={p.id}
                item={{ type: "prompt", data: p }}
                onUpdatePrompt={updatePrompt}
                onDeletePrompt={deletePrompt}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
