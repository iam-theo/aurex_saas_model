# AUREX APPLICATION MODIFICATION WORKFLOW

## 1. PURPOSE

Govern modifications to existing applications.

---

# 2. INSPECT

Before changing code, understand:

- Existing architecture
- Relevant files
- Existing behavior
- Dependencies
- Data model
- APIs
- Tests

---

# 3. DEFINE IMPACT

Determine:

- What changes
- What depends on it
- What could break
- Whether database changes are required
- Whether API contracts change
- Whether UI changes are required

---

# 4. PLAN

Choose the smallest coherent implementation.

Do not rewrite unrelated systems.

---

# 5. IMPLEMENT

Modify only the necessary areas.

Preserve existing conventions.

---

# 6. INTEGRATE

Connect the change with:

- Existing APIs
- Database
- Authentication
- UI
- State
- External services

---

# 7. TEST

Test:

- New behavior
- Existing affected behavior
- Edge cases
- Error states

---

# 8. REGRESSION

Verify that unrelated functionality still works.

---

# 9. DELIVERY

Report:

- Change implemented
- Affected areas
- Tests
- Important considerations

---

# 10. GOLDEN RULE

**Modify the existing system intelligently; do not destroy it simply to rebuild it.**
