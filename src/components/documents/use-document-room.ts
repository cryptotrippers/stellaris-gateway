import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { projectTypeOf, type ProjectType } from "./document-taxonomy";
import type { DocumentRoomViewer, ProjectDocument } from "./document-types";
import { getDocumentRoom, listReleasedDocuments } from "./documents.functions";

const SIGNED_OUT: DocumentRoomViewer = { signedIn: false, isOwner: false, isAdmin: false };

export const documentRoomKey = (fundingRequestId: string) =>
  ["document-room", fundingRequestId] as const;

/** Loads the document room as the current visitor may see it. */
export function useDocumentRoom(fundingRequestId: string, category: string) {
  const { user, loading } = useSupabaseUser();
  const fetchRoom = useServerFn(getDocumentRoom);
  const fetchReleased = useServerFn(listReleasedDocuments);
  const query = useQuery({
    queryKey: [...documentRoomKey(fundingRequestId), user?.id ?? "signed-out"],
    enabled: !loading,
    staleTime: 30_000,
    queryFn: async (): Promise<{
      viewer: DocumentRoomViewer;
      projectType: ProjectType;
      documents: ProjectDocument[];
    }> => {
      if (user) return fetchRoom({ data: { fundingRequestId } });
      const res = await fetchReleased({ data: { fundingRequestId } });
      return { viewer: SIGNED_OUT, projectType: projectTypeOf(category), documents: res.documents };
    },
  });
  return { query, authLoading: loading };
}
