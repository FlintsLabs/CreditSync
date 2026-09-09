export interface RepaymentLineage {
    repostOfIntakePublicId?: string | null;
    repostedByIntakePublicId?: string | null;
}

export function repaymentLineageTarget(item: RepaymentLineage) {
    if (item.repostOfIntakePublicId) return { publicId: item.repostOfIntakePublicId, labelKey: "loanDetail.repaymentHistory.viewOriginal" };
    if (item.repostedByIntakePublicId) return { publicId: item.repostedByIntakePublicId, labelKey: "loanDetail.repaymentHistory.viewRepost" };
    return null;
}
