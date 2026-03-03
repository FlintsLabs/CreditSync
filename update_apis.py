import os
import re

modules_dir = 'backend/src/modules'
for filename in os.listdir(modules_dir):
    if filename.endswith('.ts'):
        filepath = os.path.join(modules_dir, filename)
        with open(filepath, 'r') as f:
            content = f.read()

        # Some t.Numeric() represent IDs.
        # specifically "id", "bankProfileId", "borrowerId", "bankLoanId", "loanId", "fileId".

        # We replace id: t.Numeric()
        content = re.sub(r'id:\s*t\.Numeric\(\)', r'id: t.String()', content)
        content = re.sub(r'id:\s*t\.Number\(\)', r'id: t.String()', content)

        content = re.sub(r'bankProfileId:\s*t\.Numeric\(\)', r'bankProfileId: t.String()', content)
        content = re.sub(r'bankProfileId:\s*t\.Optional\(t\.Numeric\(\)\)', r'bankProfileId: t.Optional(t.String())', content)
        content = re.sub(r'bankProfileId:\s*t\.Number\(\)', r'bankProfileId: t.String()', content)
        content = re.sub(r'bankProfileId:\s*t\.Optional\(t\.Number\(\)\)', r'bankProfileId: t.Optional(t.String())', content)

        content = re.sub(r'borrowerId:\s*t\.Numeric\(\)', r'borrowerId: t.String()', content)
        content = re.sub(r'borrowerId:\s*t\.Optional\(t\.Numeric\(\)\)', r'borrowerId: t.Optional(t.String())', content)
        content = re.sub(r'borrowerId:\s*t\.Number\(\)', r'borrowerId: t.String()', content)
        content = re.sub(r'borrowerId:\s*t\.Optional\(t\.Number\(\)\)', r'borrowerId: t.Optional(t.String())', content)

        content = re.sub(r'bankLoanId:\s*t\.Numeric\(\)', r'bankLoanId: t.String()', content)
        content = re.sub(r'bankLoanId:\s*t\.Optional\(t\.Numeric\(\)\)', r'bankLoanId: t.Optional(t.String())', content)
        content = re.sub(r'bankLoanId:\s*t\.Number\(\)', r'bankLoanId: t.String()', content)
        content = re.sub(r'bankLoanId:\s*t\.Optional\(t\.Number\(\)\)', r'bankLoanId: t.Optional(t.String())', content)

        content = re.sub(r'loanId:\s*t\.Numeric\(\)', r'loanId: t.String()', content)
        content = re.sub(r'loanId:\s*t\.Optional\(t\.Numeric\(\)\)', r'loanId: t.Optional(t.String())', content)
        content = re.sub(r'loanId:\s*t\.Number\(\)', r'loanId: t.String()', content)
        content = re.sub(r'loanId:\s*t\.Optional\(t\.Number\(\)\)', r'loanId: t.Optional(t.String())', content)

        content = re.sub(r'fileId:\s*t\.Numeric\(\)', r'fileId: t.String()', content)
        content = re.sub(r'fileId:\s*t\.Optional\(t\.Numeric\(\)\)', r'fileId: t.Optional(t.String())', content)
        content = re.sub(r'fileId:\s*t\.Number\(\)', r'fileId: t.String()', content)
        content = re.sub(r'fileId:\s*t\.Optional\(t\.Number\(\)\)', r'fileId: t.Optional(t.String())', content)

        # For files.ts which has parse id
        content = content.replace("eq(files.id, Number(id))", "eq(files.id, id)")
        content = content.replace("parseInt(params.id)", "params.id")

        with open(filepath, 'w') as f:
            f.write(content)
