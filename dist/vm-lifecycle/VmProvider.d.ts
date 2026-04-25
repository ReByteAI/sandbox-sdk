import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';

interface VmContextValue {
    sandboxId: string;
}
declare function useVm(): VmContextValue;
interface VmProviderProps {
    sandboxId: string | null;
    children: ReactNode;
}
declare function VmProvider({ sandboxId, children }: VmProviderProps): react_jsx_runtime.JSX.Element;

export { VmProvider, type VmProviderProps, useVm };
