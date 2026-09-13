export type Reference = { pending: boolean; hash?: string; metadata?: Record<string,string>[] };
export type ObjectState = { exists: boolean; mime?: string; size?: number; hash?: string; metadata?: Record<string,string> };
export function inspectRecovery(file: {mime: string; size: number}, refs: Reference[], object: ObjectState): string {
    if(refs.length && refs.every(ref=>ref.pending)) return 'pending_warning';
    if(!object.exists) return 'missing_object';
    if(object.mime!==file.mime) return 'mime_mismatch';
    if(object.size!==file.size) return 'size_mismatch';
    for(const ref of refs.filter(ref=>!ref.pending)) {
        if(ref.hash && object.hash!==ref.hash) return 'checksum_mismatch';
        if(ref.hash && !ref.metadata?.length) return 'unsupported_provenance';
        if(ref.metadata && !ref.metadata.some(candidate=>Object.keys(candidate).length>0 && Object.entries(candidate).every(([key,value])=>object.metadata?.[key]===value))) return 'metadata_mismatch';
    }
    return 'pass';
}
