/** Private host adapter. Public packages receive only JSON control descriptors. */
export type ViewerControl = { id: string; label: string; node: HTMLElement; run(): void };
export type ViewerControlsChanged = (controls: ViewerControl[]) => void;
