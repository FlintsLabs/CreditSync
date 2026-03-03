import re

with open('backend/src/db/schema.ts', 'r') as f:
    content = f.read()

# Update imports
content = content.replace(
    'import { pgTable, text, serial, timestamp, numeric, boolean, integer, date, pgEnum } from "drizzle-orm/pg-core";',
    'import { pgTable, text, timestamp, numeric, boolean, integer, date, pgEnum, uuid } from "drizzle-orm/pg-core";'
)

# Replace ID declarations
content = re.sub(
    r'id: serial\("id"\)\.primaryKey\(\),',
    r'id: uuid("id").primaryKey().defaultRandom(),',
    content
)

# Update foreign keys
relations = [
    ("bankProfileId", "bank_profile_id"),
    ("borrowerId", "borrower_id"),
    ("bankLoanId", "bank_loan_id"),
    ("clonedFromLoanId", "cloned_from_loan_id"),
    ("loanId", "loan_id"),
    ("fileId", "file_id")
]

for js_name, db_name in relations:
    pattern = rf'{js_name}: integer\("{db_name}"\)'
    replace = rf'{js_name}: uuid("{db_name}")'
    content = re.sub(pattern, replace, content)

with open('backend/src/db/schema.ts', 'w') as f:
    f.write(content)
