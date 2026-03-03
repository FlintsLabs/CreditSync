import os
import re

directories = ['frontend/src/pages', 'frontend/src/lib', 'frontend/src/components']

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Find interface fields mapping
    # id: number => id: string
    new_content = re.sub(r'\bid:\s*number\b', r'id: string', content)
    new_content = re.sub(r'\bborrowerId:\s*number\b', r'borrowerId: string', content)
    new_content = re.sub(r'\bbankLoanId:\s*number\b', r'bankLoanId: string', content)
    new_content = re.sub(r'\bbankProfileId:\s*number\b', r'bankProfileId: string', content)
    new_content = re.sub(r'\bloanId:\s*number\b', r'loanId: string', content)
    new_content = re.sub(r'\bfileId:\s*number\b', r'fileId: string', content)

    # Convert id type comparisons or usages
    # e.g., === Number(id) -> === id
    new_content = re.sub(r'Number\((id|[^)]*id[^)]*)\)', r'\1', new_content)
    new_content = re.sub(r'parseInt\((id|[^)]*id[^)]*)\)', r'\1', new_content)

    # Check for `<number>` usages in useQuery hooks etc if present
    # Usually we don't need to change but let's check basic ones

    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

for d in directories:
    for root, dirs, files in os.walk(d):
        for f in files:
            if f.endswith('.ts') or f.endswith('.tsx'):
                process_file(os.path.join(root, f))
