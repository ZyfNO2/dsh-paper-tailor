export interface PaperSection { heading: string; summary: string; page: number; quote: string }
export interface PaperComponent { kind: 'Baseline' | 'Method' | 'Module' | 'Experiment'; name: string; description: string; page: number; quote: string }
export interface LibraryPaper {
  id: string; owner: string; name: string; sha256: string; pages: string[]; importedAt: string;
  revision: string | null; title: string; sections: PaperSection[]; components: PaperComponent[]; updatedAt: string | null;
}
