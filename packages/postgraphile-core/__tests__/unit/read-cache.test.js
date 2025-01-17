const fs = require("fs");
const graphileBuild = require("graphile-build");
const { getPostGraphileBuilder } = require("../..");

jest.mock("fs");
jest.mock("graphile-build");

beforeEach(() => {
  // required for mocks assertions
  jest.resetAllMocks();
});

/*

Current behaviour of getPostGraphileBuilder and readCache option:

1. cacheString is loaded by reading the file defined by readCache
2. memoizeCache is set by JSON.parse(cacheString)
3. persistentMemoizeWithKey is a function created dynamically that will use memoizeCache
4. getBuilder(imported from graphile-build) is called, passing persistentMemoizeWithKey as one of the arguments

Test strategy for readCache

1. Mock fs.readFile to control input
2. Mock getBuilder to control output
3. Test different inputs and validate that getBuilder is called with expected output

*/

test("when cache file has content, persistentMemoizeWithKey should be a valid function", async () => {
  // mock fs.readFile to return an object
  fs.readFile.mockImplementationOnce((path, options, cb) =>
    cb(null, '{ "__test": true }')
  );

  // mock getBuilder to fake output
  const expectedOutput = {};
  graphileBuild.getBuilder.mockResolvedValueOnce(expectedOutput);
  // call our method and test output
  const output = await getPostGraphileBuilder({}, [], {
    readCache: "path/to/cache",
  });
  expect(output).toBe(expectedOutput);
  expect(fs.readFile).toHaveBeenCalledTimes(1);
  expect(graphileBuild.getBuilder).toHaveBeenCalledTimes(1);
  // check persistentMemoizeWithKey, the actual "result" of readCache flag
  const {
    persistentMemoizeWithKey,
  } = graphileBuild.getBuilder.mock.calls[0][1];
  expect(typeof persistentMemoizeWithKey).toBe("function");
  expect(persistentMemoizeWithKey("__test")).toEqual(true);
  expect(() => persistentMemoizeWithKey("unknown_key")).toThrow();
});

test("when no readCache flag, persistentMemoizeWithKey should be undefined", async () => {
  // mock getBuilder to fake output
  const expectedOutput = {};
  graphileBuild.getBuilder.mockResolvedValueOnce(expectedOutput);
  // call our method and test output
  const output = await getPostGraphileBuilder({}, [], {});
  expect(output).toBe(expectedOutput);
  expect(graphileBuild.getBuilder).toHaveBeenCalledTimes(1);
  // check persistentMemoizeWithKey, the actual "result" of readCache flag
  const {
    persistentMemoizeWithKey,
  } = graphileBuild.getBuilder.mock.calls[0][1];
  expect(persistentMemoizeWithKey).toBeUndefined();
});

test("when cache file has invalid content, getPostGraphileBuilder should error", async () => {
  // mock fs.readFile to return an object
  fs.readFile.mockImplementationOnce((path, options, cb) =>
    cb(null, "thisisnotjson")
  );

  // call our method and check error

  let error;
  try {
    await getPostGraphileBuilder({}, [], {
      readCache: "path/to/cache",
    });
  } catch (e) {
    error = e;
  }
  expect(error).toMatchSnapshot();
  expect(fs.readFile).toHaveBeenCalledTimes(1);
});
